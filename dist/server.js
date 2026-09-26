"use strict";
/**
 * MEDPARK SECURE MoM — Mock Backend (Express + TypeScript)
 *
 * Simulates a fully-local (offline) pipeline:
 *   ASR (speech-to-text) -> LLM extraction -> Email dispatch to Mailpit.
 *
 * Endpoints:
 *   GET  /                  -> serves index.html
 *   GET  /openapi.yaml      -> raw OpenAPI spec
 *   GET  /api-docs | /docs  -> Swagger UI
 *   POST /api/pipeline      -> accepts multipart audio upload, returns { id }
 *   GET  /api/status/:id    -> returns pipeline progress; final result when done
 *
 * Run (dev):   npm run dev
 * Run (build): npm run build && npm start
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const multer_1 = __importDefault(require("multer"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const PORT = Number(process.env.PORT) || 3000;
const MAX_BYTES = 50 * 1024 * 1024; // 50 MB upload cap
// Static assets (index.html, openapi.yaml) live in the project root, which is
// the CWD for both `npm run dev` and `npm start` — regardless of dist/ output.
const STATIC_DIR = process.cwd();
/* ------------------------------------------------------------------ */
/* In-memory state                                                    */
/* ------------------------------------------------------------------ */
/** jobId -> job */
const jobs = new Map();
/** Swagger UI page — loads assets from the Swagger CDN, spec from this server. */
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
/* Mock data                                                          */
/* ------------------------------------------------------------------ */
// Canned "MoM" results keyed by meeting category so the demo feels responsive.
const MOM_TEMPLATES = {
    'Medical Board': {
        summary: 'Discussed patient case #4092. Approved emergency cardiac intervention ' +
            'and post-op ICU protocols. Reviewed anesthesia risk profile and confirmed ' +
            'availability of the surgical team for the scheduled window.',
        decisions: [
            'Proceed with TAVI procedure on Tuesday morning.',
            'Allocate extra dosage reserves in ICU.',
            'Assign Dr. Cojocaru as lead surgeon for case #4092.',
        ],
        actionItems: [
            { action: 'Finalize surgical kit', owner: 'Dr. Cojocaru', deadline: '2026-09-27' },
            { action: 'Transfer lab results', owner: 'Nurse Anna', deadline: 'Today 18:00' },
            { action: 'Confirm ICU bed reservation', owner: 'Ward Coordinator', deadline: '2026-09-26' },
        ],
        transcript: [
            { lang: 'EN', text: 'Chair: Let us begin with patient case number 4092.' },
            { lang: 'RO', text: 'Dr. Cojocaru: Pacientul necesită o intervenție cardiacă de urgență.' },
            { lang: 'EN', text: 'Dr. Cojocaru: The patient requires an emergency cardiac intervention.' },
            { lang: 'RO', text: 'Asistenta Anna: Rezultatele de laborator vor fi transferate până la ora 18:00.' },
            { lang: 'EN', text: 'Nurse Anna: Lab results will be transferred by 18:00 today.' },
        ],
    },
    'Executive Board': {
        summary: 'Reviewed Q3 operational performance and the 2027 capital expenditure plan. ' +
            'Approved budget reallocation toward the new imaging wing and discussed ' +
            'hiring targets for the upcoming quarter.',
        decisions: [
            'Approve CapEx for the new MRI suite.',
            'Freeze non-clinical hiring until Q1 2027.',
            'Green-light the telemedicine pilot program.',
        ],
        actionItems: [
            { action: 'Draft MRI procurement RFP', owner: 'CFO Office', deadline: '2026-10-05' },
            { action: 'Publish hiring freeze memo', owner: 'HR Director', deadline: '2026-09-28' },
            { action: 'Scope telemedicine vendors', owner: 'CTO', deadline: '2026-10-10' },
        ],
        transcript: [
            { lang: 'EN', text: 'CEO: Q3 revenue is up 6% against forecast.' },
            { lang: 'RO', text: 'CFO: Propun realocarea bugetului către noua aripă de imagistică.' },
            { lang: 'EN', text: 'CFO: I propose reallocating the budget toward the new imaging wing.' },
        ],
    },
    'Administrative': {
        summary: 'Covered facility maintenance schedules, updated visitor policy, and the ' +
            'rollout of the new records management system across departments.',
        decisions: [
            'Adopt the new digital visitor sign-in system.',
            'Schedule HVAC maintenance for the east wing next weekend.',
            'Migrate paper records to the new DMS by end of quarter.',
        ],
        actionItems: [
            { action: 'Deploy visitor kiosks', owner: 'Facilities', deadline: '2026-10-02' },
            { action: 'Book HVAC contractor', owner: 'Ops Manager', deadline: '2026-09-29' },
            { action: 'Train staff on DMS', owner: 'IT Support', deadline: '2026-10-15' },
        ],
        transcript: [
            { lang: 'EN', text: 'Admin: The new visitor policy takes effect next Monday.' },
            { lang: 'RO', text: 'IT: Migrarea documentelor va fi finalizată până la sfârșitul trimestrului.' },
            { lang: 'EN', text: 'IT: Document migration will be completed by end of quarter.' },
        ],
    },
};
// Pipeline stages, each with a simulated duration (ms).
const STAGES = [
    { key: 'asr', label: 'ASR', durationMs: 3200 },
    { key: 'llm', label: 'LLM Extraction', durationMs: 4100 },
    { key: 'email', label: 'Email Sent to Mailpit', durationMs: 1200 },
];
const VALID_CATEGORIES = ['Medical Board', 'Executive Board', 'Administrative'];
/* ------------------------------------------------------------------ */
/* Pipeline simulation                                                */
/* ------------------------------------------------------------------ */
function startPipeline(job) {
    let index = 0;
    const runNext = () => {
        if (index >= STAGES.length) {
            job.status = 'done';
            job.progress = 100;
            job.result = buildResult(job);
            return;
        }
        const stage = STAGES[index];
        const step = job.steps[index];
        job.status = 'running';
        job.currentStage = stage.key;
        step.state = 'running';
        step.startedAt = Date.now();
        setTimeout(() => {
            const elapsed = ((Date.now() - (step.startedAt ?? Date.now())) / 1000).toFixed(1);
            step.state = 'done';
            step.elapsed = elapsed;
            index += 1;
            job.progress = Math.round((index / STAGES.length) * 100);
            runNext();
        }, stage.durationMs);
    };
    runNext();
}
function buildResult(job) {
    const template = MOM_TEMPLATES[job.category] ?? MOM_TEMPLATES['Medical Board'];
    return {
        category: job.category,
        targetInbox: job.targetInbox,
        fileName: job.fileName,
        ...template,
    };
}
/* ------------------------------------------------------------------ */
/* Express app                                                        */
/* ------------------------------------------------------------------ */
const app = (0, express_1.default)();
// multer: keep uploads in memory — we only need the byte count for the mock.
const upload = (0, multer_1.default)({
    storage: multer_1.default.memoryStorage(),
    limits: { fileSize: MAX_BYTES },
});
// Permissive CORS for the demo frontend.
app.use((_req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});
app.options('*', (_req, res) => res.sendStatus(204));
// --- Static frontend & docs ------------------------------------------------
app.get(['/', '/index.html'], (_req, res) => {
    res.sendFile(path_1.default.join(STATIC_DIR, 'index.html'));
});
app.get(['/openapi.yaml', '/openapi.yml'], (_req, res) => {
    res.type('application/yaml').sendFile(path_1.default.join(STATIC_DIR, 'openapi.yaml'));
});
app.get(['/api-docs', '/docs'], (_req, res) => {
    res.type('html').send(SWAGGER_HTML);
});
// --- Submit a job ----------------------------------------------------------
app.post('/api/pipeline', upload.single('audio'), (req, res) => {
    const file = req.file;
    const rawCategory = req.body?.category || 'Medical Board';
    const category = VALID_CATEGORIES.includes(rawCategory)
        ? rawCategory
        : 'Medical Board';
    const targetInbox = req.body?.targetInbox || 'medical-board@medpark.local';
    // Validation — surface errors the frontend can display.
    if (!file || !file.originalname) {
        return res.status(422).json({ error: 'No audio file received. Please attach a recording.' });
    }
    if (file.size === 0) {
        return res.status(422).json({ error: 'Audio file is empty.' });
    }
    const id = crypto_1.default.randomBytes(8).toString('hex');
    const job = {
        id,
        status: 'queued',
        progress: 0,
        category,
        targetInbox,
        fileName: file.originalname,
        fileSize: file.size,
        currentStage: null,
        createdAt: Date.now(),
        steps: STAGES.map((s) => ({ key: s.key, label: s.label, state: 'pending', elapsed: null })),
        result: null,
    };
    jobs.set(id, job);
    startPipeline(job);
    return res.status(202).json({ id, status: job.status });
});
// --- Poll job status -------------------------------------------------------
app.get('/api/status/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) {
        return res.status(404).json({ error: 'Unknown job id.' });
    }
    return res.status(200).json({
        id: job.id,
        status: job.status,
        progress: job.progress,
        currentStage: job.currentStage,
        steps: job.steps.map(({ startedAt, ...rest }) => rest), // hide internal timestamp
        result: job.status === 'done' ? job.result : null,
    });
});
// --- Error handler (e.g. multer file-size limit) ---------------------------
app.use((err, _req, res, _next) => {
    if (err instanceof multer_1.default.MulterError) {
        const msg = err.code === 'LIMIT_FILE_SIZE'
            ? 'Audio file exceeds the 50 MB limit.'
            : `Upload error: ${err.message}`;
        return res.status(400).json({ error: msg });
    }
    return res.status(500).json({ error: 'Internal server error.' });
});
// --- 404 fallback ----------------------------------------------------------
app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
});
app.listen(PORT, () => {
    console.log(`\n  MEDPARK SECURE MoM mock backend (Express + TypeScript)`);
    console.log(`  Listening on http://localhost:${PORT}`);
    console.log(`  API docs at   http://localhost:${PORT}/api-docs\n`);
});
//# sourceMappingURL=server.js.map