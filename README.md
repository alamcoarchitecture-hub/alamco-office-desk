# Alamco Studio Office Desk

ഓഫീസ് (studio) ജോലികൾ ഏൽപ്പിക്കാനും പരിശോധിക്കാനും ഉള്ള ചെറിയ വെബ് ആപ്പ്.
A small mobile-friendly web app for the studio's internal work assignment. Node.js + Express, plain HTML/JS, JSON-file storage (no database).

Jobs ("briefs") arrive from the existing `alamco-webhook` / alamcostudio.com via `POST /api/ingest`.

## Pipeline

`new (awaiting payment)` → `work_started` (planning charge confirmed) → `survey_verified` → `drafting` (drafter assigned) → `draft_ready` → `senior_verified` → `sent_to_client` → `approved`

Ingest only moves a job **forward**. The website re-sends old states (e.g. `new` after a revert), which are ignored, so duplicates never create noise or regress a job.

## Run locally

```bash
npm install
export DESK_OWNER_PIN=1234 DESK_INGEST_SECRET=some-long-random DRY_RUN=1
npm start              # http://localhost:3100
bash scripts/smoke.sh  # full end-to-end test in DRY_RUN (38 checks)
```

Open the site → pick "Owner" + `DESK_OWNER_PIN` → **Team** page: set a PIN (4–8 digits) for each staff member (they can log in only after a PIN is set), optionally their Telegram chat id.

Send a test job:

```bash
curl -X POST localhost:3100/api/ingest -H "Authorization: Bearer $DESK_INGEST_SECRET" -H 'Content-Type: application/json' \
  -d '{"job_id":"ALM-1","status":"work_started","client":{"name":"Test","phone":"9999999999"},"plot":"5 cent","floors":2,"payment":{"amount":5000,"paid_at":"2026-10-10T12:09:45Z"}}'
```

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `DESK_OWNER_PIN` | yes (else owner login disabled) | Owner PIN (4+ digits). Never stored; compared from env. |
| `DESK_INGEST_SECRET` | yes (else `/api/ingest` returns 503) | Bearer secret for `/api/ingest`; also lets a cron call `GET /api/summary` and `POST /api/summary/send`. |
| `DESK_SESSION_SECRET` | recommended | Signs session cookies. If unset a random one is used (everyone is logged out on each restart). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | for live alerts | Bot token + the owner's chat id. If either is missing the app stays in dry-run. |
| `DRY_RUN` | optional | `1` = print notifications instead of sending (forced). |
| `DESK_BASE_URL` | optional | Public URL; adds a job link to Telegram messages. |
| `NOTIFY_OWNER_ON_INGEST` | optional | `1` = owner also gets a Telegram message when a new job is created (off by default: the webhook already alerts the owner). |
| `DATA_DIR` | optional | Where `db.json` lives (default `./data`). On Render, point at a persistent disk. |
| `TRUST_PROXY` | on Render | `1` so rate-limiting/secure cookies see the real client behind the proxy. |
| `NODE_ENV` | on Render | `production` → cookies get the `Secure` flag. |
| `PORT` | optional | Default 3100 (Render sets it). |

Secrets are never written to files or logs. Telegram errors are scrubbed of the token.

## Roles & permissions

| Action | owner | senior_architect | drafter | surveyor |
|---|---|---|---|---|
| Assign drafter (needs survey verified) / surveyor | ✓ | ✓ | | |
| Mark survey verified | ✓ | ✓ | own jobs | own jobs |
| Mark draft ready (+ file link) | ✓ | | own jobs | |
| Senior verify / Request changes / Send to client | ✓ | ✓ | | |
| Approve | ✓ | | | |
| Add note | ✓ | ✓ | own jobs | own jobs |
| Override stage (needs a reason) | ✓ | | | |
| Team page, send summary | ✓ | | | |

Client phone numbers are visible only to owner and senior architect. Every action is stored in the job's history (who, role, when, from→to).

## Telegram

* Assignment → the assignee gets a message (if they have a `telegram_chat_id`).
* Draft ready → all senior architects with a chat id; changes requested → the drafter.
* Every action → the owner gets a summary (`TELEGRAM_CHAT_ID`).
* `POST /api/summary/send` (owner login or ingest secret) sends the pending-items summary to the owner — hit it from a Render cron job for a daily digest.
* A staff member gets their chat id by messaging the bot; the existing bot `Alamcostudio_alert_bot` can be reused (same token as the webhook) or a separate one.

In dry-run, messages are printed to the log (`[notify:dry-run] …`) and, for the owner, listed at `GET /api/debug/outbox` (only exists in dry-run).

## API (all JSON)

`POST /api/login {staff_id,pin}` · `POST /api/logout` · `GET /api/me` · `GET /api/jobs` · `GET /api/jobs/:id` · `POST /api/jobs/:id/actions {action,…}` · `GET /api/my-work` · `GET /api/summary` · `POST /api/summary/send` · `GET/POST/PATCH/DELETE /api/staff` · `POST /api/ingest` · `GET /health`

Actions: `assign_drafter{staff_id}`, `assign_surveyor{staff_id}`, `survey_verified`, `draft_ready{file_url,label?}`, `senior_verify`, `request_changes{text}`, `send_to_client`, `approve`, `note{text}`, `set_stage{stage,text}`.

## Connecting the webhook (not done yet)

`alamco-webhook` does not forward to the desk yet. A small follow-up there: after parsing a platform event, `fetch(DESK_INGEST_URL, {method:'POST', headers:{Authorization:'Bearer '+DESK_INGEST_SECRET,'Content-Type':'application/json'}, body: JSON.stringify(payload)})` (fire-and-forget). Ingest is idempotent, so repeats are harmless.

## Deploying to Render (NOT done; for later)

1. Push this repo to GitHub (private).
2. Render → New **Web Service** from the repo. Runtime Node, build `npm install`, start `npm start`.
3. Add a **Disk** (e.g. 1 GB) mounted at `/var/data` and set `DATA_DIR=/var/data` — without a disk the JSON file is lost on every deploy. (A disk requires a paid instance; the free tier is ephemeral.)
4. Environment: `NODE_ENV=production`, `TRUST_PROXY=1`, `DESK_OWNER_PIN`, `DESK_SESSION_SECRET` (random 32+ chars), `DESK_INGEST_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `DESK_BASE_URL=https://<service>.onrender.com`. Leave `DRY_RUN` unset for live messages.
5. Health check path: `/health`. Run a single instance only.
6. Optional Render Cron Job (daily, 9:00 IST = `30 3 * * *` UTC): `curl -fsS -X POST -H "Authorization: Bearer $DESK_INGEST_SECRET" $DESK_BASE_URL/api/summary/send`.

## Limitations

* JSON file store, single process: fine for a small studio, not for concurrent multi-instance scaling. Back up `db.json`.
* Draft "files" are links (Drive/Dropbox etc.); there is no file upload.
* "Send to client" only records the step. It does not message the client (the webhook/WhatsApp flow does that).
* PINs are short; protected by scrypt hashing, per-user and per-IP login throttling (in memory) and HTTPS in production. Use `DESK_SESSION_SECRET` so sessions survive restarts. No password reset: the owner sets a new PIN in Team.
* Login page lists staff names (dropdown login). Acceptable for an internal tool; put it behind obscurity/Render access controls if that matters.
* Ingest accepts several payload shapes but real production payloads should be checked once; unknown statuses are ignored (the job is still created/updated).
* UI strings are Malayalam + English; no language switch.
