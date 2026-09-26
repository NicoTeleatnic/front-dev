/**
 * MEDPARK SECURE MoM — Express backend
 *
 * The page still talks to this server. Uploads are forwarded to the
 * Secure MOM service running in Docker (mom-llm-v1):
 *   POST /api/v1/meetings
 *   GET  /api/v1/meetings/{job_id}/status
 *   GET  /api/v1/meetings/{job_id}/result
 *
 * Endpoints served here:
 *   GET  /                  -> index.html
 *   GET  /openapi.yaml      -> raw OpenAPI spec
 *   GET  /api-docs | /docs  -> Swagger UI
 *   POST /api/pipeline      -> forwards the audio file, returns { id }
 *   GET  /api/status/:id    -> maps the LLM job into the page's progress shape
 *
 * When the meeting service reports COMPLETED, this server routes the minutes:
 *   1. POST the MoM JSON to the local n8n webhook
 *   2. Send the same minutes by SMTP to the category inbox (Mailpit)
 *
 * LLM_BASE_URL     defaults to http://127.0.0.1:8000
 * N8N_WEBHOOK_URL  defaults to http://127.0.0.1:5678/webhook/secure-mom
 * SMTP_HOST/PORT   default to 127.0.0.1:1025 (Mailpit)
 */

import express, { Request, Response } from 'express';
import multer from 'multer';
import net from 'net';
import path from 'path';

const PORT: number = Number(process.env.PORT) || 3000;
const MAX_MB = 60;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const N8N_WEBHOOK_URL = (process.env.N8N_WEBHOOK_URL || 'http://127.0.0.1:5678/webhook/secure-mom').replace(/\/$/, '');
const N8N_ENABLED = process.env.N8N_ENABLED !== 'false';
const SMTP_HOST = process.env.SMTP_HOST || '127.0.0.1';
const SMTP_PORT = Number(process.env.SMTP_PORT) || 1025;
const SMTP_FROM = process.env.SMTP_FROM || 'mom-bot@medpark.local';
const SMTP_ENABLED = process.env.SMTP_ENABLED !== 'false';
const STATIC_DIR = process.cwd();

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

type MeetingCategory = 'Medical Board' | 'Executive Board' | 'Administrative';
type MeetingType = 'Medical' | 'Executive' | 'Administrative';
type StageKey = 'asr' | 'llm' | 'email';
type StepState = 'pending' | 'running' | 'done' | 'error';
type JobStatus = 'queued' | 'running' | 'done' | 'error';
type LlmStage = 'QUEUED' | 'TRANSCRIBING' | 'EXTRACTING_DECISIONS' | 'COMPLETED' | 'FAILED';

interface ActionItem {
  action: string;
  owner: string;
  deadline: string;
}

interface TranscriptLine {
  lang: string;
  text: string;
}

interface MoMResult {
  category: MeetingCategory;
  targetInbox: string;
  fileName: string;
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
  transcript: TranscriptLine[];
}

interface Step {
  key: StageKey;
  label: string;
  state: StepState;
  elapsed: string | null;
}

interface ChannelResult {
  enabled: boolean;
  ok: boolean;
  detail: string;
}

interface DeliveryReport {
  targetInbox: string;
  n8n: ChannelResult;
  smtp: ChannelResult;
}

type DeliveryState = 'pending' | 'sending' | 'done' | 'error';

interface TrackedJob {
  targetInbox: string;
  fileName: string;
  category: MeetingCategory;
  result: MoMResult | null;
  deliveryState: DeliveryState;
  deliveryError: string | null;
  deliveryStartedAt: number | null;
  deliveryFinishedAt: number | null;
  delivery: DeliveryReport | null;
  deliveryTask: Promise<void> | null;
}

interface LlmJobCreated {
  job_id: string;
  status: LlmStage;
  message: string;
}

interface LlmJobStatus {
  job_id: string;
  status: LlmStage;
  progress_percent: number;
  elapsed_seconds: number;
  message: string;
}

interface LlmActionItem {
  task: string;
  owner: string;
  deadline: string;
}

interface LlmMoMResult {
  job_id: string;
  status: LlmStage;
  meeting_type: string;
  filename: string;
  summary: string;
  decisions_made: string[];
  action_items: LlmActionItem[];
  transcript_preview: string;
}

/* ------------------------------------------------------------------ */
/* In-memory metadata (the LLM service owns the actual job)          */
/* ------------------------------------------------------------------ */

const jobs = new Map<string, TrackedJob>();

const CATEGORY_TO_TYPE: Record<MeetingCategory, MeetingType> = {
  'Medical Board': 'Medical',
  'Executive Board': 'Executive',
  Administrative: 'Administrative',
};

const TYPE_TO_CATEGORY: Record<string, MeetingCategory> = {
  Medical: 'Medical Board',
  Executive: 'Executive Board',
  Administrative: 'Administrative',
};

const VALID_CATEGORIES: MeetingCategory[] = ['Medical Board', 'Executive Board', 'Administrative'];

/** On-prem distribution lists. The UI may override these with targetInbox. */
const CATEGORY_INBOX: Record<MeetingCategory, string> = {
  'Medical Board': 'medical-board@medpark.local',
  'Executive Board': 'executive-board@medpark.local',
  Administrative: 'admin@medpark.local',
};

function blankJob(partial: Partial<TrackedJob> = {}): TrackedJob {
  return {
    targetInbox: '',
    fileName: '',
    category: 'Medical Board',
    result: null,
    deliveryState: 'pending',
    deliveryError: null,
    deliveryStartedAt: null,
    deliveryFinishedAt: null,
    delivery: null,
    deliveryTask: null,
    ...partial,
  };
}

function resolveInbox(category: MeetingCategory, requested: string): string {
  const trimmed = requested.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return trimmed;
  return CATEGORY_INBOX[category];
}

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>MEDPARK SECURE MoM — API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
  <style>
    body { margin: 0; background: #0b1220; }
    .topbar { display: none; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-standalone-preset.js" crossorigin></script>
  <script>
    window.onload = function () {
      window.ui = SwaggerUIBundle({
        url: '/openapi.yaml',
        dom_id: '#swagger-ui',
        deepLinking: true,
        presets: [SwaggerUIBundle.presets.apis, SwaggerUIStandalonePreset],
        layout: 'StandaloneLayout',
        tryItOutEnabled: true
      });
    };
  </script>
</body>
</html>`;

/* ------------------------------------------------------------------ */
/* LLM client                                                         */
/* ------------------------------------------------------------------ */

class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}

async function llmFetch(apiPath: string, init: RequestInit = {}, timeoutMs = 20000): Promise<globalThis.Response> {
  try {
    return await fetch(`${LLM_BASE_URL}${apiPath}`, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new LlmError(
      `Meeting service at ${LLM_BASE_URL} is not reachable (${detail}). Is mom-llm-v1 running with port 8000 published?`,
      502,
    );
  }
}

async function readJson(res: globalThis.Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { message: text };
  }
}

function errorText(body: Record<string, unknown>, fallback: string): string {
  const detail = body.detail;
  if (typeof detail === 'string' && detail.trim()) return detail;
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (item && typeof item === 'object' && 'msg' in item && typeof item.msg === 'string') return item.msg;
        return '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join('; ');
  }
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  if (typeof body.error === 'string' && body.error.trim()) return body.error;
  return fallback;
}

function meetingTypeFor(category: MeetingCategory): MeetingType {
  return CATEGORY_TO_TYPE[category] ?? 'Medical';
}

function categoryFor(meetingType: string, fallback: MeetingCategory): MeetingCategory {
  return TYPE_TO_CATEGORY[meetingType] ?? fallback;
}

/** Guess the language of a transcript line from its script and diacritics. */
function detectLang(text: string): string {
  if (/[\u0400-\u04FF]/.test(text)) return 'RU';
  if (/[ăâîșțĂÂÎȘȚ]/.test(text)) return 'RO';
  return 'EN';
}

/**
 * The service returns the transcript as one string. Lines are separated by
 * newlines or by `[hh:mm:ss]` timestamps, so split on both.
 */
function previewToTranscript(preview: string): TranscriptLine[] {
  if (!preview || !preview.trim()) return [];

  const chunks = preview
    .split(/\r?\n/)
    .flatMap((line) => line.split(/(?=\[\d{1,2}:\d{2}(?::\d{2})?\])/))
    .map((line) => line.trim())
    .filter(Boolean);

  return chunks.map((line) => {
    const tagged = line.match(/^\[?(EN|RO|RU)\]?\s*[:\-]\s*(.+)$/i);
    if (tagged) return { lang: tagged[1].toUpperCase(), text: tagged[2] };
    return { lang: detectLang(line), text: line };
  });
}

function mapResult(remote: LlmMoMResult, job: TrackedJob): MoMResult {
  return {
    category: categoryFor(remote.meeting_type, job.category),
    targetInbox: job.targetInbox,
    fileName: remote.filename || job.fileName,
    summary: remote.summary || '',
    decisions: remote.decisions_made || [],
    actionItems: (remote.action_items || []).map((item) => ({
      action: item.task,
      owner: item.owner,
      deadline: item.deadline,
    })),
    transcript: previewToTranscript(remote.transcript_preview || ''),
  };
}

function stepsFor(
  stage: LlmStage,
  elapsedSeconds: number,
  email: { state: StepState; elapsed: string | null } = { state: 'pending', elapsed: null },
): { status: JobStatus; currentStage: StageKey | null; steps: Step[] } {
  const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds.toFixed(1) : null;
  const steps: Step[] = [
    { key: 'asr', label: 'ASR', state: 'pending', elapsed: null },
    { key: 'llm', label: 'LLM Extraction', state: 'pending', elapsed: null },
    { key: 'email', label: 'Email via n8n + SMTP', state: 'pending', elapsed: null },
  ];

  if (stage === 'QUEUED') {
    return { status: 'queued', currentStage: null, steps };
  }
  if (stage === 'TRANSCRIBING') {
    steps[0].state = 'running';
    steps[0].elapsed = elapsed;
    return { status: 'running', currentStage: 'asr', steps };
  }
  if (stage === 'EXTRACTING_DECISIONS') {
    steps[0].state = 'done';
    steps[1].state = 'running';
    steps[1].elapsed = elapsed;
    return { status: 'running', currentStage: 'llm', steps };
  }
  if (stage === 'FAILED') {
    steps[0].state = 'error';
    return { status: 'error', currentStage: 'asr', steps };
  }

  steps[0].state = 'done';
  steps[1].state = 'done';
  steps[2].state = email.state;
  steps[2].elapsed = email.elapsed;
  if (email.state === 'error') return { status: 'error', currentStage: 'email', steps };
  if (email.state === 'done') return { status: 'done', currentStage: 'email', steps };
  return { status: 'running', currentStage: 'email', steps };
}

interface MomPayload {
  jobId: string;
  category: MeetingCategory;
  meetingType: MeetingType;
  targetInbox: string;
  fileName: string;
  summary: string;
  decisions: string[];
  actionItems: ActionItem[];
  transcript: TranscriptLine[];
}

function momPayload(jobId: string, result: MoMResult): MomPayload {
  return {
    jobId,
    category: result.category,
    meetingType: meetingTypeFor(result.category),
    targetInbox: result.targetInbox,
    fileName: result.fileName,
    summary: result.summary,
    decisions: result.decisions,
    actionItems: result.actionItems,
    transcript: result.transcript,
  };
}

function minutesText(payload: MomPayload): string {
  const decisions = payload.decisions.length
    ? payload.decisions.map((item) => `- ${item}`).join('\n')
    : '- (none)';
  const actions = payload.actionItems.length
    ? payload.actionItems.map((item) => `- ${item.action} | ${item.owner} | ${item.deadline}`).join('\n')
    : '- (none)';

  return [
    'MEDPARK Secure Minutes of Meeting',
    `Category: ${payload.category}`,
    `File: ${payload.fileName}`,
    `Inbox: ${payload.targetInbox}`,
    '',
    'Summary',
    payload.summary || '(empty)',
    '',
    'Decisions',
    decisions,
    '',
    'Action items',
    actions,
    '',
  ].join('\n');
}

async function postToN8n(payload: MomPayload): Promise<string> {
  let res: globalThis.Response;
  try {
    res = await fetch(N8N_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `n8n at ${N8N_WEBHOOK_URL} is not reachable (${detail}). Start n8n and activate the Secure MOM workflow.`,
    );
  }

  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `n8n webhook returned ${res.status}. Import workflows/secure-mom.json, turn it Active, and use ${N8N_WEBHOOK_URL}. ${text.slice(0, 180)}`.trim(),
    );
  }
  return `accepted (${res.status})`;
}

function smtpMessage(from: string, to: string, subject: string, body: string): string {
  const safeSubject = subject.replace(/[\r\n]+/g, ' ');
  const stuffed = body
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => (line.startsWith('.') ? `.${line}` : line))
    .join('\r\n');

  return [
    `From: MEDPARK Secure MoM <${from}>`,
    `To: ${to}`,
    `Subject: ${safeSubject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    stuffed,
    '.',
  ].join('\r\n');
}

function sendSmtp(to: string, subject: string, body: string): Promise<string> {
  const payload = smtpMessage(SMTP_FROM, to, subject, body);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: SMTP_HOST, port: SMTP_PORT });
    let buffer = '';
    let phase: 'greeting' | 'ehlo' | 'mail' | 'rcpt' | 'data' | 'body' | 'quit' = 'greeting';
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(`sent to ${to} via ${SMTP_HOST}:${SMTP_PORT}`);
    };

    const write = (line: string) => {
      socket.write(`${line}\r\n`);
    };

    socket.setTimeout(8000, () => {
      finish(new Error(`SMTP timed out at ${SMTP_HOST}:${SMTP_PORT}. Is Mailpit running?`));
    });

    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED') {
        finish(new Error(`SMTP refused ${SMTP_HOST}:${SMTP_PORT}. Start Mailpit with docker compose up -d.`));
        return;
      }
      finish(err);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() ?? '';

      for (const line of parts) {
        if (!line || (line.length >= 4 && line[3] === '-')) continue;
        const code = Number(line.slice(0, 3));
        if (!Number.isFinite(code)) continue;
        if (code >= 400) {
          finish(new Error(`SMTP error from ${SMTP_HOST}:${SMTP_PORT}: ${line}`));
          return;
        }

        if (phase === 'greeting') {
          write('EHLO medpark.local');
          phase = 'ehlo';
        } else if (phase === 'ehlo') {
          write(`MAIL FROM:<${SMTP_FROM}>`);
          phase = 'mail';
        } else if (phase === 'mail') {
          write(`RCPT TO:<${to}>`);
          phase = 'rcpt';
        } else if (phase === 'rcpt') {
          write('DATA');
          phase = 'data';
        } else if (phase === 'data') {
          socket.write(`${payload}\r\n`);
          phase = 'body';
        } else if (phase === 'body') {
          write('QUIT');
          phase = 'quit';
        } else {
          finish();
        }
      }
    });
  });
}

async function deliverMinutes(jobId: string, job: TrackedJob, result: MoMResult): Promise<void> {
  if (job.deliveryState === 'done' || job.deliveryState === 'error') return;

  job.deliveryState = 'sending';
  job.deliveryStartedAt = Date.now();
  const payload = momPayload(jobId, result);
  const subject = `MoM ${payload.category}: ${payload.fileName}`;
  const body = minutesText(payload);

  const n8n: ChannelResult = { enabled: N8N_ENABLED, ok: !N8N_ENABLED, detail: N8N_ENABLED ? '' : 'disabled' };
  const smtp: ChannelResult = { enabled: SMTP_ENABLED, ok: !SMTP_ENABLED, detail: SMTP_ENABLED ? '' : 'disabled' };
  const failures: string[] = [];

  const tasks: Promise<void>[] = [];
  if (N8N_ENABLED) {
    tasks.push(
      postToN8n(payload)
        .then((detail) => {
          n8n.ok = true;
          n8n.detail = detail;
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          n8n.ok = false;
          n8n.detail = detail;
          failures.push(detail);
        }),
    );
  }
  if (SMTP_ENABLED) {
    tasks.push(
      sendSmtp(result.targetInbox, subject, body)
        .then((detail) => {
          smtp.ok = true;
          smtp.detail = detail;
        })
        .catch((err: unknown) => {
          const detail = err instanceof Error ? err.message : String(err);
          smtp.ok = false;
          smtp.detail = detail;
          failures.push(detail);
        }),
    );
  }

  await Promise.all(tasks);
  job.deliveryFinishedAt = Date.now();
  job.delivery = { targetInbox: result.targetInbox, n8n, smtp };

  if (failures.length) {
    job.deliveryState = 'error';
    job.deliveryError = failures.join(' | ');
    return;
  }

  job.deliveryState = 'done';
  job.deliveryError = null;
}

function ensureDelivered(jobId: string, job: TrackedJob, result: MoMResult): Promise<void> {
  if (job.deliveryState === 'done' || job.deliveryState === 'error') return Promise.resolve();
  if (!job.deliveryTask) {
    job.deliveryTask = deliverMinutes(jobId, job, result).finally(() => {
      job.deliveryTask = null;
    });
  }
  return job.deliveryTask;
}

function emailProgress(job: TrackedJob): { state: StepState; elapsed: string | null } {
  const elapsed =
    job.deliveryStartedAt && job.deliveryFinishedAt
      ? ((job.deliveryFinishedAt - job.deliveryStartedAt) / 1000).toFixed(1)
      : null;
  if (job.deliveryState === 'done') return { state: 'done', elapsed };
  if (job.deliveryState === 'error') return { state: 'error', elapsed };
  if (job.deliveryState === 'sending') return { state: 'running', elapsed: null };
  return { state: 'pending', elapsed: null };
}

async function submitAudio(
  file: Express.Multer.File,
  meetingType: MeetingType,
): Promise<LlmJobCreated> {
  const form = new FormData();
  const copy = new ArrayBuffer(file.buffer.byteLength);
  new Uint8Array(copy).set(file.buffer);
  form.append('file', new Blob([copy], { type: file.mimetype || 'application/octet-stream' }), file.originalname);
  form.append('meeting_type', meetingType);

  const res = await llmFetch('/api/v1/meetings', { method: 'POST', body: form }, 120000);
  const body = await readJson(res);
  if (!res.ok) {
    throw new LlmError(errorText(body, `Upload rejected by the meeting service (${res.status}).`), res.status);
  }
  const jobId = body.job_id;
  if (typeof jobId !== 'string' || !jobId) {
    throw new LlmError('Meeting service did not return a job id.', 502);
  }
  return body as unknown as LlmJobCreated;
}

async function fetchStatus(jobId: string): Promise<LlmJobStatus> {
  const res = await llmFetch(`/api/v1/meetings/${encodeURIComponent(jobId)}/status`);
  const body = await readJson(res);
  if (res.status === 404) throw new LlmError('Unknown job id.', 404);
  if (!res.ok) throw new LlmError(errorText(body, `Status request failed (${res.status}).`), res.status);
  return body as unknown as LlmJobStatus;
}

async function fetchResult(jobId: string): Promise<LlmMoMResult> {
  const res = await llmFetch(`/api/v1/meetings/${encodeURIComponent(jobId)}/result`);
  const body = await readJson(res);
  if (!res.ok) throw new LlmError(errorText(body, `Result request failed (${res.status}).`), res.status);
  return body as unknown as LlmMoMResult;
}

/* ------------------------------------------------------------------ */
/* Express app                                                        */
/* ------------------------------------------------------------------ */

const app = express();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});
app.options('*', (_req, res) => res.sendStatus(204));

app.get(['/', '/index.html'], (_req: Request, res: Response) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.get(['/openapi.yaml', '/openapi.yml'], (_req: Request, res: Response) => {
  res.type('application/yaml').sendFile(path.join(STATIC_DIR, 'openapi.yaml'));
});

app.get(['/api-docs', '/docs'], (_req: Request, res: Response) => {
  res.type('html').send(SWAGGER_HTML);
});

app.post('/api/pipeline', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    const file = req.file;
    const rawCategory = (req.body?.category as string) || 'Medical Board';
    const category: MeetingCategory = VALID_CATEGORIES.includes(rawCategory as MeetingCategory)
      ? (rawCategory as MeetingCategory)
      : 'Medical Board';
    const targetInbox = resolveInbox(category, (req.body?.targetInbox as string) || '');

    if (!file || !file.originalname) {
      return res.status(422).json({ error: 'No audio file received. Please attach a recording.' });
    }
    if (file.size === 0) {
      return res.status(422).json({ error: 'Audio file is empty.' });
    }

    const created = await submitAudio(file, meetingTypeFor(category));
    jobs.set(
      created.job_id,
      blankJob({
        targetInbox,
        fileName: file.originalname,
        category,
      }),
    );

    return res.status(202).json({ id: created.job_id, status: 'queued' });
  } catch (err) {
    return sendLlmError(res, err);
  }
});

app.get('/api/status/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const remote = await fetchStatus(id);
    const tracked = jobs.get(id) ?? blankJob();
    if (!jobs.has(id)) jobs.set(id, tracked);

    let result: MoMResult | null = null;
    if (remote.status === 'COMPLETED') {
      if (!tracked.targetInbox) tracked.targetInbox = resolveInbox(tracked.category, '');
      if (!tracked.result) tracked.result = mapResult(await fetchResult(id), tracked);
      result = tracked.result;
      await ensureDelivered(id, tracked, result);
    }

    const mapped = stepsFor(remote.status, remote.elapsed_seconds, emailProgress(tracked));
    let message: string | undefined;
    if (remote.status === 'FAILED') message = remote.message || 'Pipeline failed.';
    else if (tracked.deliveryState === 'error' && tracked.deliveryError) message = tracked.deliveryError;

    const progress =
      mapped.status === 'done' ? 100 : remote.status === 'COMPLETED' ? Math.max(remote.progress_percent ?? 0, 90) : remote.progress_percent ?? 0;

    return res.status(200).json({
      id,
      status: mapped.status,
      progress,
      currentStage: mapped.currentStage,
      steps: mapped.steps,
      result,
      message,
      delivery: tracked.delivery,
    });
  } catch (err) {
    return sendLlmError(res, err);
  }
});

function sendLlmError(res: Response, err: unknown): Response {
  if (err instanceof LlmError) {
    const status = err.status >= 400 && err.status < 600 ? err.status : 502;
    return res.status(status).json({ error: err.message });
  }
  const message = err instanceof Error ? err.message : 'Internal server error.';
  return res.status(500).json({ error: message });
}

app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    const msg =
      err.code === 'LIMIT_FILE_SIZE'
        ? `Audio file exceeds the ${MAX_MB} MB limit.`
        : `Upload error: ${err.message}`;
    return res.status(400).json({ error: msg });
  }
  return res.status(500).json({ error: 'Internal server error.' });
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

app.listen(PORT, () => {
  console.log(`\n  MEDPARK SECURE MoM backend`);
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log(`  Forwarding audio to ${LLM_BASE_URL}`);
  console.log(`  n8n webhook    ${N8N_ENABLED ? N8N_WEBHOOK_URL : 'disabled'}`);
  console.log(`  SMTP           ${SMTP_ENABLED ? `${SMTP_HOST}:${SMTP_PORT} from ${SMTP_FROM}` : 'disabled'}`);
  console.log(`  API docs at    http://localhost:${PORT}/api-docs\n`);
});
