# Run n8n and SMTP on this laptop

The MEDPARK backend (`server.ts`) does not send mail itself to the internet. After the meeting service finishes a transcript, the backend routes the minutes in two places, both on this machine:

| Meeting category   | Inbox                             |
| ------------------ | --------------------------------- |
| Medical Board      | `medical-board@medpark.local`     |
| Executive Board    | `executive-board@medpark.local`   |
| Administrative     | `admin@medpark.local`             |

The page can override the inbox with the **Target inbox** field. The backend then:

1. `POST`s the minutes JSON to n8n at `http://127.0.0.1:5678/webhook/secure-mom`
2. Sends the same minutes by SMTP to Mailpit at `127.0.0.1:1025`

Mailpit keeps the message in a local inbox. It does not forward it to Gmail, Outlook, or any hospital server.

## What you need installed

- Docker Desktop for Windows (WSL2 backend turned on). Give it at least 4 GB RAM so n8n can start.
- Node.js 20 or newer (the backend already uses it).
- The meeting service still has to be running at `http://127.0.0.1:8000` (`LLM_BASE_URL`). n8n and Mailpit do not replace that service.

## 1. Start n8n and Mailpit

Open PowerShell:

```powershell
cd C:\Users\Nicoleta\hak-old\front-dev
docker compose up -d
```

Check that both containers are up:

```powershell
docker compose ps
```

You want `medpark-mailpit` and `medpark-n8n` in state `running`.

| Service | Address | What it is |
| ------- | ------- | ---------- |
| Mailpit SMTP | `127.0.0.1:1025` | Where the backend sends mail |
| Mailpit inbox | http://localhost:8025 | Open this to read the minutes |
| n8n | http://localhost:5678 | Workflow editor |

The first `docker compose up` downloads the images. That step needs internet once. After the images are on the laptop, later starts do not.

## 2. Create the n8n webhook

n8n ignores the backend until a workflow is **Active**.

1. Open http://localhost:5678
2. Create the owner account. Any local email and password is fine. It stays on this laptop.
3. Menu (three dots or the workflow list) → **Import from file**
4. Choose `C:\Users\Nicoleta\hak-old\front-dev\workflows\secure-mom.json`
5. Open the imported workflow **Secure MOM**
6. Switch it to **Active** (toggle, top right)

The production URL must be:

```text
http://localhost:5678/webhook/secure-mom
```

The test URL (`/webhook-test/secure-mom`) only works while you click "Listen for test event". Leave the workflow Active and use the production URL. That is the URL the backend calls.

In n8n, open **Executions** after a pipeline run. Each finished meeting should appear as one execution with the summary, decisions, and action items.

## 3. Start the backend

```powershell
cd C:\Users\Nicoleta\hak-old\front-dev
npm install
npm run dev
```

The console should print:

```text
n8n webhook    http://127.0.0.1:5678/webhook/secure-mom
SMTP           127.0.0.1:1025 from mom-bot@medpark.local
```

Open http://localhost:3000 , attach audio, pick a meeting category, and run the pipeline. When the third step **Email** is done:

- Mailpit (http://localhost:8025) shows the minutes in the category inbox
- n8n **Executions** shows the webhook call

## Optional overrides

Defaults match the table above. Set them in the same PowerShell window before `npm run dev` only if you changed a port:

```powershell
$env:N8N_WEBHOOK_URL = "http://127.0.0.1:5678/webhook/secure-mom"
$env:SMTP_HOST = "127.0.0.1"
$env:SMTP_PORT = "1025"
npm run dev
```

To send mail without n8n (Mailpit only):

```powershell
$env:N8N_ENABLED = "false"
npm run dev
```

To call n8n without sending SMTP:

```powershell
$env:SMTP_ENABLED = "false"
npm run dev
```

See `.env.example` for the full list. The process does not read a `.env` file on its own; export the variables in PowerShell.

## If the Email step fails

The red banner is the exact failure.

- `SMTP refused 127.0.0.1:1025` — Mailpit is not running. Run `docker compose up -d` again, then open http://localhost:8025
- `n8n ... is not reachable` — the n8n container is down, or port 5678 is taken
- `n8n webhook returned 404` — the workflow is not Active, or the path is not `secure-mom`. Import `workflows/secure-mom.json` and turn Active on

Stop the two containers when you are finished:

```powershell
cd C:\Users\Nicoleta\hak-old\front-dev
docker compose stop
```
