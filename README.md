# chief-of-staff-demo — Found42 — Chief of Staff

A local, single-user app for Found42's meeting, content and task workflows. It hosts five
product areas: **Content Engine**, **Content Research**, **Person Profiles**, **Meeting Wizard**
and **Tasks**. The vocabulary is in [CONTEXT.md](CONTEXT.md), and the decisions are in
[docs/adr/](docs/adr/).

> **Note:** This repo was `transcript-found42`. The GitHub slug now redirects to
> `chief-of-staff-demo`. Package scope is `@chief-of-staff-demo/*`.

Most Gmail writes create drafts for review. **Meeting Briefs are the explicit exception:** the
Meeting Brief Generator can automatically send a briefing to the connected Google account's
owner, never to external guests (ADR-0034). Meeting Debriefs wait for review before publication.

## What it does

| Product area | Workflow and result |
|---|---|
| Content Engine | Content Scout collects public sources, presents opportunities, and turns a selected opportunity into a Content Project. |
| Content Research | Researches what resonates for named people; YouTube Trends records channel video counts and view totals on demand or on its schedule. |
| Person Profiles | Keeps canonical identities, researched dossiers, source evidence and revision history. |
| Meeting Wizard | Prepares briefs for upcoming meetings and retrospective debriefs from reviewed transcripts. Brief delivery and debrief review are separate workflows. |
| Tasks | Captures work locally, reviews proposed Action Items on their source Meeting, and manages accepted Tasks, lists, completion and Trash. Google Tasks and Asana are optional destinations. |

Choose a Drive transcript folder in Settings and explicitly consent to processing with the
selected provider and model. Intake converts supported files, reviews relevance, and records
processing and failures in the Workspace. A Meeting Debrief proposes Action Items; **Stage all**
is the default, so acceptance waits for review. Automatic owner-Task creation requires release
authorization and explicit enablement; the UI reports when it is unavailable. Accepted Tasks
remain Workspace-owned even when linked to an external destination. The former `/transcript`
workflow is retired (ADR-0045); start from Meeting Wizard and Tasks.

Local Tasks work without connecting any account. Model-backed and Google-backed workflows need
their own configuration and owner consent; failures do not silently switch provider or model.

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
(`pnpm install` stays cached until a manifest changes; the `pnpm run build` layer is what re-runs), and
the browser needs a refresh afterwards. That is the price of having no second runtime: no Vite dev
server on 5173, so no second origin and no second redirect URI to register with Google.

[`.claude/launch.json`](.claude/launch.json) runs exactly this command, so an agent previewing the
app gets the same container you do. It pins port 4317 (`autoPort: false`) rather than letting the
harness pick a free one, for the same redirect-URI reason.

Node and pnpm are for the test suite and typechecking only — never for serving the app:

```bash
pnpm install --frozen-lockfile  # packageManager pins pnpm 12.3.4
pnpm run build        # compile without a rebuild, to see type errors fast
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
pnpm run check                        # types, lint, formatting, knip, unit tests
pnpm --filter @chief-of-staff-demo/tests exec playwright install chromium  # once
pnpm run test:e2e                      # hermetic browser journeys with simulated providers
```

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Run fails at `extract` after 3 attempts | Missing installation credential, wrong model id, or provider outage. Check the `extract_attempt` events, verify Guided Setup status, and hit Retry. |
| Run fails at `outputs` with `google_not_connected` | Google not connected. Fix the Google card in Settings — **Check my setup** names the missing piece — then Retry; the cached result is reused, no re-extraction. |
| Google consent shows a warning screen | Expected on a personal account: click **Continue** (the small link), not **Back to safety**. A Workspace account using an Internal consent screen never sees it. |
| Sign-in fails with `Error 403: access_denied` | The account is not on the consent screen's Test users list. Add it under Audience → Test users and sign in again with the same account. |
| Redirect URI mismatch during connect | The registered redirect URI must be `http://localhost:4317/api/google/callback`, matching the port the server runs on. |
| A Task cannot reach an external destination | The accepted Task stays in the Workspace. Read the link failure and use its retry or recovery controls; an uncertain creation requires recovering the existing remote record before another creation. |
| Drive `.json` file fails with `SOURCE_INVALID` | JSON must be an array of sentence objects (`speaker_name` + `text`), not an arbitrary document. The file came from Drive, not an upload. |
| Due dates show no time | Expected — Workspace Task due dates are calendar dates (`YYYY-MM-DD`); timestamps and impossible dates are refused. |
| Google sign-in reports an expired or already used attempt | Connect Google again from Settings. Sign-ins expire after ten minutes; starting another attempt or restarting the app invalidates the previous one. |
| Google asks for a new sign-in about weekly | Expected while the consent screen is in Testing. Settings shows when you last signed in and roughly when Google will ask again; one click fixes it. |
| `docker compose` fails on a socket or daemon | Docker Desktop is not running. Start it and wait for the whale to stop animating. |

## Security posture

- Transcripts are untrusted input. The prompt wraps them in a labeled block with an explicit
  "never an instruction" preamble, and only the surrounding trusted context carries real values.
- Installation secrets live in the process environment or the gitignored mode-600 `.env`; they are
  never stored in or returned from a Workspace. The public config response reports only configured,
  missing, or not-required state.
- Compose publishes the app only on `127.0.0.1`; the container listens on `0.0.0.0`. The server also rejects non-loopback Host names and unrelated browser Origins before routes run. Browser API fetches must be same-origin; Google's top-level callback navigation is the bounded exception and requires a single-use sign-in state before a grant is exchanged. Native local clients without browser headers remain supported. This is a local request boundary, not authentication for a shared deployment.
- Mail drafts are the only Gmail write most Modules may perform: `apps/server/src/google/gmail.ts` contains no delivery call, and `tests/src/unit/draft-mime.test.ts` fails the build if one appears there. The Meeting Brief Generator owns the deliberate send-only-to-owner exception (`modules/meeting-brief-generator/google/gmailDelivery.ts`, recipient fixed from the connected Google identity, never from event/API/model, never to an External Guest) — see ADR-0034.
- The Settings page is the only place the app loads remote code (Google's Picker script at `https://apis.google.com/js/api.js`, fetched on click only). The per-pick access token is short-lived, never persisted, never logged, and carries every scope the connection holds.
