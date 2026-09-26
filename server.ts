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
 * LLM_BASE_URL defaults to http://127.0.0.1:8000
 */

import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';

const PORT: number = Number(process.env.PORT) || 3000;
const MAX_MB = 60;
const MAX_BYTES = MAX_MB * 1024 * 1024;
const LLM_BASE_URL = (process.env.LLM_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
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

interface TrackedJob {
  targetInbox: string;
  fileName: string;
  category: MeetingCategory;
  result: MoMResult | null;
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

function stepsFor(stage: LlmStage, elapsedSeconds: number): { status: JobStatus; currentStage: StageKey | null; steps: Step[] } {
  const elapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds.toFixed(1) : null;
  const steps: Step[] = [
    { key: 'asr', label: 'ASR', state: 'pending', elapsed: null },
    { key: 'llm', label: 'LLM Extraction', state: 'pending', elapsed: null },
    { key: 'email', label: 'Complete', state: 'pending', elapsed: null },
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

  steps.forEach((step) => {
    step.state = 'done';
  });
  steps[2].elapsed = elapsed;
  return { status: 'done', currentStage: 'email', steps };
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
    const targetInbox = (req.body?.targetInbox as string) || 'medical-board@medpark.local';

    if (!file || !file.originalname) {
      return res.status(422).json({ error: 'No audio file received. Please attach a recording.' });
    }
    if (file.size === 0) {
      return res.status(422).json({ error: 'Audio file is empty.' });
    }

    const created = await submitAudio(file, meetingTypeFor(category));
    jobs.set(created.job_id, {
      targetInbox,
      fileName: file.originalname,
      category,
      result: null,
    });

    return res.status(202).json({ id: created.job_id, status: 'queued' });
  } catch (err) {
    return sendLlmError(res, err);
  }
});

app.get('/api/status/:id', async (req: Request, res: Response) => {
  try {
    const id = req.params.id;
    const remote = await fetchStatus(id);
    const tracked = jobs.get(id) ?? {
      targetInbox: '',
      fileName: '',
      category: 'Medical Board' as MeetingCategory,
      result: null,
    };
    if (!jobs.has(id)) jobs.set(id, tracked);

    const mapped = stepsFor(remote.status, remote.elapsed_seconds);
    let result: MoMResult | null = null;

    if (remote.status === 'COMPLETED') {
      if (!tracked.result) tracked.result = mapResult(await fetchResult(id), tracked);
      result = tracked.result;
    }

    return res.status(200).json({
      id,
      status: mapped.status,
      progress: remote.status === 'COMPLETED' ? 100 : remote.progress_percent ?? 0,
      currentStage: mapped.currentStage,
      steps: mapped.steps,
      result,
      message: remote.status === 'FAILED' ? remote.message || 'Pipeline failed.' : undefined,
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
  console.log(`  API docs at   http://localhost:${PORT}/api-docs\n`);
});
