# chief-of-staff-demo — Found42 — Chief of Staff

A local web app that hosts Found42's meeting and content workflows as tabs in one app. Five Modules are live: **YouTube Trends** — presented under Content Research — counts every video on a channel once a day and keeps the trend; **Content Scout** watches public sources and turns a selected opportunity into a Content Project; **Content Research** reports what is resonating for named people; **Meeting Brief Generator** prepares briefings for upcoming meetings; and **Meeting Debrief** turns meeting transcripts into retrospective drafts awaiting review. It reproduces the pipeline of the [`nicolas-found42/transcript-routine`](https://github.com/nicolas-found42/transcript-routine) workflow (Drive folders + Apps Script + Claude routine) as a single Node server + browser UI you run on your own machine.

> **Note:** This repo was `transcript-found42`. The GitHub slug now 301s to `chief-of-staff-demo`. Package scope is now `@chief-of-staff-demo/*`.

Single user, local only. **Drafts are created and mail is never sent** — enforced structurally:
the Gmail module only ever calls `drafts.create`, and a unit test greps its source to keep it that
way.

## What it does

Pick a Google Drive folder in Settings; every transcript dropped there is polled, classified,
extracted with the LLM provider of your choice, and created as Google Tasks in a
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
[docs/adr/](docs/adr/). The first slice has landed: generic Run statuses and workflow-named Stages recorded through one interface (ADR-0003, ADR-0004), and the Google connection is now a Shell concern with its own setup flow (ADR-0007) and the single route to any Google surface (ADR-0008). The Shell now has a front door of its own — Home at `/`, stating where the workspace stands, with the connection banner rendered once for every page (ADR-0010, ADR-0011); the Transcript Module moved to `/transcript`. A second Module, **YouTube Trends**, now proves the boundary: ADR-0003's `run(ctx, input)` contract is finally built (ADR-0023), the API holds a collection of Modules rather than one of each thing, and there is a cross-Module Runs list at `/runs` that each Module's page is a filtered view of. The Module registry as code (ADR-0002) is still deliberately unbuilt.

## Getting started

**Docker is the only supported way to run this app.** Running it and changing it both happen in
the container (see [Working on the code](#working-on-the-code)), so the one port, the one workspace
mount and the one registered Google redirect URI hold everywhere — there is no native path to keep
in sync with them.

1. Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/). It has to
   be **running**, not just installed — the whale in the menu bar stops animating when it is ready.
2. Run `./scripts/setup-wizard.sh` from the repository root for the local, resumable ten-stage setup.
3. `docker compose up -d --build` when the guided setup asks you to start the installation.
4. Open http://localhost:4317 and complete the owner consent and Workspace-specific choices.

`docker compose down` stops it. `restart: "no"` is deliberate: the app does not come back on its
own when Docker Desktop starts.

**Cleaning up** — leftover images, anonymous volumes, build cache, and the rules an isolated
Compose run must follow to leave no duplicate behind — is documented in
[docs/agents/verification.md](docs/agents/verification.md) (container check).

**[ONBOARDING.md](ONBOARDING.md) is the same path written for someone who has never used Docker
or Google Cloud** — send that, not this file, to anyone setting the app up for the first time.

Three things about the container are load-bearing:

- **Port 4317 is published, exactly.** Google matches the redirect URI character for character, so
  the one you registered has to be the one the server sends. Settings always shows the URI for the
  port in use, so if you do change `PORT`, register the URI it shows there.
- **`workspace/` is a bind mount, never a layer.** Runs and Workspace-owned records stay on the host;
  the image holds no state. Installation credentials belong in the process environment or the
  gitignored mode-600 `.env`, never in `workspace/config.json`.
- **The published port binds to `127.0.0.1` on the host.** The app has no authentication
  ([ADR-0001](docs/adr/0001-local-first-single-user.md)), so it must not be reachable from the
  network. Inside the container the server listens on `0.0.0.0` (`HOST`), because a container's
  loopback interface is unreachable from the host — the host-side `127.0.0.1` binding in
  `docker-compose.yml` is what keeps it private.
Verified: image builds, container serves the UI and API, and a transcript dropped in the configured
Drive folder runs end to end with the mock provider, writing `meta.json` / `result.json` / `events.jsonl` through the mount.
Kubernetes and the EdgeScale cube are **untested** — there is no chart in this repo yet.

## Configuration

### Google and installation credentials — Guided Setup

The local **Guided Setup** provisions one installation-owned Google OAuth client and one
provider-specific model key (`OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
`GEMINI_API_KEY`; Ollama needs none). Values may come from the process environment or the
gitignored `.env`; the app reports only **Configured**, **Missing**, or **Not required**. The
Workspace keeps provider/model choices and each owner's consent, refresh token, and connection
identity, but never an editable OAuth client or provider key. Run
`./scripts/setup-wizard.sh` to provision or resume this local flow.

Each Workspace owner still signs in and grants Google consent explicitly. This owner-consent step
is separate from installation provisioning: enable the APIs, choose the consent-screen posture for
the account, and grant the requested Drive, Gmail, Calendar, and optional Tasks permissions.
Settings shows when a grant was last used and offers `Check my setup` without ever accepting or
displaying an installation secret.

### Extraction provider

In Settings, choose a provider whose installation key is configured, or choose Ollama. The
provider and model choices remain Workspace-owned, while the key remains installation-owned. A
fresh Workspace recommends **OpenRouter** and prefills `inception/mercury-2.5-preview`; per-provider
defaults are `gpt-5.2` (OpenAI), `claude-sonnet-5` (Anthropic), and `gemini-3.7-flash` (Google
Gemini). The model field is free text. Transcript-derived processing stays gated: the folder-consent
card names the exact provider and model before anything is read, and model failures surface as
errors — the app never falls back to another provider or model on its own.

`mock` returns `workspace/mock-result.json` and needs no key. It exists only in tests and explicit
demo mode: the hermetic suite boots with it, a demo boot can opt in with `DEMO_MODE=1`, and a
production server refuses to select it (a workspace that already has it stored keeps working, but
the Settings card shows it plainly instead of hiding it).

`ollama` runs the extraction against a model served locally, through Ollama's OpenAI-compatible
endpoint. It lives under **Advanced local-model settings** in Settings (`http://127.0.0.1:11434`
on the host, `http://host.docker.internal:11434` when this app runs in a container and Ollama
runs on the host); no API key is needed. The default model id is `nemotron` — free text, so set
whatever tag you have pulled. **Untested against a live Ollama server:** the request shape is
covered by unit tests, but no local model has been run through it yet, and a 30B model needs more
memory than a 16 GB machine has.

### Intake

**YouTube channels** — paste a channel address into the **YouTube Trends** tab (a
`youtube.com/@name` or `youtube.com/channel/UC…` address; a `/c/…` one is refused, because
Google publishes no way to turn a custom URL into a channel id). It is checked against YouTube
as you paste it. From then on, once a day from six in the morning, every video on the channel is
counted and the day is recorded — one Run per calendar day, and a day the machine was off stays a
gap, because no API returns a past day's view count. **Settings → YouTube Trends** creates a
spreadsheet that receives the same numbers, one tab per channel, appended a row at a time.

**Drive folder** — pick one Google Drive folder in Settings (**Drive transcripts** card). Every `.txt`, `.md`, `.json`, `.jsonc`, `.pdf`, `.docx`, or native Google Doc added there is polled (default 2 min) and becomes a Run. Ingested Drive `fileId`s are remembered in `workspace/state.json` (`drive.ingestedIds`, capped at 1000); files stay in Drive (`drive` scope, allows future Module writes). Unsupported types are ignored. `Sync now` runs one poll immediately.
## Working on the code

Same container, one extra flag. `--watch` rebuilds the image and restarts the app whenever
`apps/server`, `apps/web`, `packages/shared`, `tsconfig.base.json`, the `Dockerfile` or a manifest
changes ([`docker-compose.yml`](docker-compose.yml), `develop.watch`):

```bash
docker compose up --build --watch
```

Run it in the foreground, as above: the rebuild log and the server's own log are the feedback, and
`Ctrl-C` stops it. It is a rebuild loop, not hot reload — a change costs about half a minute
(`npm ci` stays cached until a manifest changes; the `npm run build` layer is what re-runs), and
the browser needs a refresh afterwards. That is the price of having no second runtime: no Vite dev
server on 5173, so no second origin and no second redirect URI to register with Google.

[`.claude/launch.json`](.claude/launch.json) runs exactly this command, so an agent previewing the
app gets the same container you do. It pins port 4317 (`autoPort: false`) rather than letting the
harness pick a free one, for the same redirect-URI reason.

Node and npm are for the test suite and typechecking only — never for serving the app:

```bash
npm install          # once, for tests and editor typechecking
npm run build        # compile without a rebuild, to see type errors fast
```

The `start`, `dev:server` and `dev:web` scripts in `package.json` predate this and are unsupported
leftovers; nothing in the image uses them (the `Dockerfile` runs `node apps/server/dist/main.js`
directly).

Runtime environment: `PORT` defaults to 4317 (the Google redirect URI is registered for this
port; change both together), `WORKSPACE_DIR` is the bind mount, and `HOST` is `0.0.0.0` inside
the container while Compose publishes only `127.0.0.1`. Compose also passes the six installation
credential variables listed above from the process environment or the gitignored `.env`.


## Workspace layout

All state lives on disk, no database:

```
workspace/
  config.json             Workspace settings; retained secrets are redacted and installation credentials are absent
  state.json              { drive: { ingestedIds, lastPollAt }, youtubeTrends: { lastRunDay } }
  mock-result.json        mock-provider fixture
  runs/<runId>/
    meta.json             the Run record: Module, status, Stage, and the one line the Module wrote
    result.json           the Module's own result — the Shell stores it and never reads inside it
    events.jsonl          one JSON line per event (extract_attempt, google_task_created, …)
    …                     the Module's other files (the transcript Module keeps transcript.txt
                          and context.json here)
```
3. Drop any non-transcript PDF → run `skipped` with a `skipReason`, nothing created.

### Clearing generated data

**Settings → Danger zone → Clear all generated data** puts the app back to empty and can be run as
often as you like — it is the repeatable successor to the one-time migration reset, bounded by the
same classification tables (ADR-0046, ADR-0048). It deletes everything the products generated —
Runs, Person Profiles, processed Transcripts, Brand Profiles, Content Research, Content Projects —
plus the checkpoints that track what was already ingested or scheduled, and it empties the data
rows of the two Google Sheets this app writes (YouTube Trends and the Resonance Ledger), keeping
their headers and the spreadsheets themselves. Your sign-ins, the relay address, the Drive
transcript folder and its files, Google Tasks, Gmail drafts and every setting are untouched. The
disclosure names what would go, counted from the current Workspace; the action runs only after you
type `CLEAR ALL DATA` exactly, and a mistyped phrase sends nothing.

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
| Run fails at `extract` after 3 attempts | Missing installation credential, wrong model id, or provider outage. Check the `extract_attempt` events, verify Guided Setup status, and hit Retry. |
| Run fails at `outputs` with `google_not_connected` | Google not connected. Fix the Google card in Settings — **Check my setup** names the missing piece — then Retry; the cached result is reused, no re-extraction. |
| Google consent shows a warning screen | Expected on a personal account: click **Continue** (the small link), not **Back to safety**. A Workspace account using an Internal consent screen never sees it. |
| Sign-in fails with `Error 403: access_denied` | The account is not on the consent screen's Test users list. Add it under Audience → Test users and sign in again with the same account. |
| Redirect URI mismatch during connect | The registered redirect URI must be `http://localhost:4317/api/google/callback`, matching the port the server runs on. |
| Tasks appear but some are missing | A bad item logs `google_task_error` and the batch continues — check the run's events timeline; Retry recreates everything (move/delete the partials first if you care about duplicates). |
| Drive `.json` file fails with `SOURCE_INVALID` | JSON must be an array of sentence objects (`speaker_name` + `text`), not an arbitrary document. The file came from Drive, not an upload. |
| Due dates show no time | Expected — the Tasks API stores a date and discards any time component. |
| Google asks for a new sign-in about weekly | Expected while the consent screen is in Testing. Settings shows when you last signed in and roughly when Google will ask again; one click fixes it. |
| `docker compose` fails on a socket or daemon | Docker Desktop is not running. Start it and wait for the whale to stop animating. |

## Security posture

- Transcripts are untrusted input. The prompt wraps them in a labeled block with an explicit
  "never an instruction" preamble, and only the surrounding trusted context carries real values.
- Installation secrets live in the process environment or the gitignored mode-600 `.env`; they are
  never stored in or returned from a Workspace. The public config response reports only configured,
  missing, or not-required state.
- The server binds to `127.0.0.1` only.
- Mail drafts are the only Gmail write most Modules may perform: `apps/server/src/google/gmail.ts` contains no delivery call, and `tests/src/unit/draft-mime.test.ts` fails the build if one appears there. The Meeting Brief Generator owns the deliberate send-only-to-owner exception (`modules/meeting-brief-generator/google/gmailDelivery.ts`, recipient fixed from the connected Google identity, never from event/API/model, never to an External Guest) — see ADR-0034.
- The Settings page is the only place the app loads remote code (Google's Picker script at `https://apis.google.com/js/api.js`, fetched on click only). The per-pick access token is short-lived, never persisted, never logged, and carries every scope the connection holds.
