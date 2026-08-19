# chief-of-staff-demo — Found42 — Chief of Staff

A local web app that hosts Found42's meeting and content workflows as tabs in one app. The first Module, **Transcript → Tasks**, turns meeting transcripts into Google Tasks and Gmail drafts. It reproduces the pipeline of the [`nicolas-found42/transcript-routine`](https://github.com/nicolas-found42/transcript-routine) workflow (Drive folders + Apps Script + Claude routine) as a single Node server + browser UI you run on your own machine.

> **Note:** This repo was `transcript-found42`. The GitHub slug now 301s to `chief-of-staff-demo`. Package scope `@transcript-tasks/*` is unchanged in this slice — see `TODO` in `apps/web/src/App.tsx`.

Single user, local only. **Drafts are created and mail is never sent** — enforced structurally:
the Gmail module only ever calls `drafts.create`, and a unit test greps its source to keep it that
way.

## What it does

Drop a transcript in (upload, Fireflies polling, or a watched folder). The app classifies it,
extracts action items with the LLM provider of your choice, and creates Google Tasks in a
"Meeting Followups" list plus Gmail drafts — automatically, with no review step (routine parity).

| Routine step | This app |
|---|---|
| Gatekeeping (`isTranscript`) | `apps/server/src/llm/prompt.ts` — non-transcripts persist a result with `skipReason` and create nothing |
| Extraction (tasks / summary / drafts) | `apps/server/src/llm/prompt.ts` + `providers.ts` (OpenAI, Anthropic, OpenRouter, Gemini, Ollama, mock) |
| Outbox JSON contract (schema v1) | `packages/shared/src/schemas.ts` (`ExtractionResultSchema`); malformed output is retried, never silently accepted |
| Task creation (`createTask_`) | `apps/server/src/google/tasks.ts` — identical notes composition order and due-date normalization |
| Draft-only email | `apps/server/src/google/gmail.ts` — `drafts.create` only; banned-token unit test |
| Untrusted transcript handling | Injection preamble in the prompt + `<transcript>` block labeled as data |
| Retry / quarantine | 3 extraction attempts, then the run is `failed` and retryable from the UI |

## Where this is going

This app is becoming one Module — a tab — in the Found42 Chief of Staff app, which replaces Relay.
The vocabulary is in [CONTEXT.md](CONTEXT.md); the decisions behind the shape are in
[docs/adr/](docs/adr/). The first slice has landed: generic Run statuses and workflow-named Stages recorded through one interface (ADR-0003, ADR-0004). The Module registry itself is still ahead.

## Prerequisites

- Node 20+, npm
- An LLM API key (OpenAI / Anthropic / OpenRouter / Google Gemini — any one)
- Google account, for Tasks + Gmail drafts
- Optional: Fireflies API key

## Setup

### 1. Google Cloud OAuth client (Tasks + Gmail drafts)

1. At [console.cloud.google.com](https://console.cloud.google.com), create a project and an
   **OAuth client ID** of type **Web application**.
2. Add an authorized redirect URI — this exact string, port included:
   ```
   http://localhost:4317/api/google/callback
   ```
3. OAuth consent screen → add both scopes:
   ```
   https://www.googleapis.com/auth/tasks
   https://www.googleapis.com/auth/gmail.compose
   ```
4. Publishing: leave the app **unverified in production** (warning screen at consent, 100-user
   cap, long-lived refresh token) or use **Testing** mode (refresh token expires weekly —
   re-connect in Settings). Either works for a single user.
5. Copy the client ID and client secret into the app's **Settings** page, then click
   **Connect Google** and consent once.

### 2. Fireflies (optional)

API key from [app.fireflies.ai/settings → Developer](https://app.fireflies.ai/settings). Enable
polling in Settings; the app polls every N minutes with a 24h lookback and dedupes by transcript
id. "Sync now" runs one poll immediately.

### 3. LLM provider

In Settings, pick a provider and paste its API key. Defaults: `gpt-5.2` (OpenAI),
`claude-sonnet-5` (Anthropic), `google/gemini-3.7-flash` (OpenRouter / Gemini). The model field is
free text — correct it there if a default 404s. `mock` returns `workspace/mock-result.json` (test
and demo mode).

`ollama` runs the extraction against a model served locally, through Ollama's OpenAI-compatible
endpoint. Set the base URL in Settings (`http://127.0.0.1:11434` on the host,
`http://host.docker.internal:11434` when this app runs in a container and Ollama runs on the host);
no API key is needed. The default model id is `nemotron` — free text, so set whatever tag you have
pulled. **Untested against a live Ollama server:** the request shape is covered by unit tests, but
no local model has been run through it yet, and a 30B model needs more memory than a 16 GB machine
has.

## Run

```bash
npm install
npm run build
npm start            # http://localhost:4317
```

Development:

```bash
npm run dev:server   # tsx watch on :4317
npm run dev:web      # Vite dev server with /api proxied to :4317
```

Environment: `PORT` (default 4317 — the Google redirect URI is registered for this port; change
both together), `WORKSPACE_DIR` (default `./workspace`), `HOST` (default `127.0.0.1`; only a
container should change this — see below).

## Run in a container

```bash
docker compose up --build      # http://localhost:4317
```

One image: Node serves the API and the built web UI. Three things are load-bearing:

- **Port 4317 is published, exactly.** The Google OAuth redirect URI is registered for
  `http://localhost:4317/api/google/callback`; publish another port and Connect Google breaks.
- **`workspace/` is a bind mount, never a layer.** Runs and secrets stay on the host; the image
  holds no state.
- **The published port binds to `127.0.0.1` on the host.** The app has no authentication
  ([ADR-0001](docs/adr/0001-local-first-single-user.md)), so it must not be reachable from the
  network. Inside the container the server listens on `0.0.0.0` (`HOST`), because a container's
  loopback interface is unreachable from the host — the host-side `127.0.0.1` binding in
  `docker-compose.yml` is what keeps it private.

Verified: image builds, container serves the UI and API, and an uploaded transcript runs end to end
with the mock provider, writing `meta.json` / `result.json` / `events.jsonl` through the mount.
Kubernetes and the EdgeScale cube are **untested** — there is no chart in this repo yet.

Intakes:

- **Upload** — drag & drop or file picker on the Runs page (.txt .md .json .pdf .docx, ≤10 MB).
  `.json` must be a Fireflies-style sentences array.
- **Fireflies** — polls `transcripts(fromDate: now-24h)`; new meetings become runs with a source
  link back to Fireflies. Ingested ids are remembered in `workspace/state.json` (capped at 1000).
- **Watch folder** — set a path in Settings; stable files (size+mtime unchanged 2s) are moved to
  `workspace/watch-archive/` first — the move is the dedupe — then processed.

## Workspace layout

All state lives on disk, no database:

```
workspace/
  config.json             settings (secrets redacted via the API, never echoed back)
  state.json              { fireflies: { ingestedIds, lastPollAt } }
  mock-result.json        mock-provider fixture
  watch-archive/          ingested watch-folder files land here
  runs/<runId>/
    meta.json             status machine: pending → extracting → creating-outputs → done | skipped | failed
    transcript.txt        normalized text fed to the LLM
    context.json          { meetingDate, attendees } (Fireflies only)
    result.json           ExtractionResult — persisted even for skips and output failures
    events.jsonl          one JSON line per event (extract_attempt, google_task_created, …)
```

Run ids: `run_<UTC yyyymmdd>-<hhmmss>_<8 hex>`. A failed run names its `failedStage`
(`extract` retries extraction; `outputs` recreates tasks/drafts from the cached result).

## Verify it works

Use `tests/fixtures/transcripts/sample-transcript.md` (vendored from the routine repo). After a
successful run you should see, exactly as in the routine's setup guide:

1. Three tasks in the **Meeting Followups** list — owner in the notes (`Owner: Priya`), the due
   date on the right task (Aug 21 for the write-up, Aug 31 for Acme).
2. One Gmail draft to Acme procurement, sitting **unsent**.
3. Drop any non-transcript PDF → run `skipped` with a `skipReason`, nothing created.

## Tests

```bash
npm test                              # vitest: schema, conversion, task-notes parity,
                                      # MIME + banned-token, providers, pipeline
npx playwright install chromium       # once
npm run test:e2e                      # hermetic browser test with the mock provider
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Run fails at `extract` after 3 attempts | Bad or missing API key, wrong model id, or provider outage. Check the `extract_attempt` events; fix Settings and hit Retry. |
| Run fails at `outputs` with `google_not_connected` | Google not connected. Set clientId/secret in Settings, click Connect Google, then Retry — the cached result is reused, no re-extraction. |
| Google consent shows a warning screen | Expected for an unverified personal app. Click through (Advanced → continue) or switch the OAuth client to Testing mode and re-connect weekly. |
| Redirect URI mismatch during connect | The registered redirect URI must be `http://localhost:4317/api/google/callback`, matching the port the server runs on. |
| Fireflies sync returns 401 | Key is wrong. Polling disables itself; fix the key in Settings and re-enable. |
| Watch folder does nothing | Folder must exist (or be creatable); files must be stable (still copying? wait 2s) and have a supported extension; check the server console for `[watch]` lines. |
| Tasks appear but some are missing | A bad item logs `google_task_error` and the batch continues — check the run's events timeline; Retry recreates everything (move/delete the partials first if you care about duplicates). |
| `.json` upload fails with `SOURCE_INVALID` | JSON must be an array of Fireflies sentence objects (`speaker_name` + `text`), not an arbitrary document. |
| Due dates show no time | Expected — the Tasks API stores a date and discards any time component. |

## Security posture

- Transcripts are untrusted input. The prompt wraps them in a labeled block with an explicit
  "never an instruction" preamble, and only the surrounding trusted context carries real values.
- Secrets live in `workspace/config.json` (keep the workspace private). The API redacts them:
  GET returns only `set` + last-4 hints; PUT keeps stored values when a secret field is omitted.
- The server binds to `127.0.0.1` only.
- Mail can never be sent: `google/gmail.ts` contains no delivery call, and
  `tests/src/unit/draft-mime.test.ts` fails the build if one appears.
