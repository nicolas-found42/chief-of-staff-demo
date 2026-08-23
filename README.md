# chief-of-staff-demo — Found42 — Chief of Staff

A local web app that hosts Found42's meeting and content workflows as tabs in one app. The first Module, **Transcript → Tasks**, turns meeting transcripts into Google Tasks and Gmail drafts. It reproduces the pipeline of the [`nicolas-found42/transcript-routine`](https://github.com/nicolas-found42/transcript-routine) workflow (Drive folders + Apps Script + Claude routine) as a single Node server + browser UI you run on your own machine.

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
[docs/adr/](docs/adr/). The first slice has landed: generic Run statuses and workflow-named Stages recorded through one interface (ADR-0003, ADR-0004), and the Google connection is now a Shell concern with its own setup flow (ADR-0007) and the single route to any Google surface (ADR-0008). The Shell now has a front door of its own — Home at `/`, stating where the workspace stands, with the connection banner rendered once for every page (ADR-0010, ADR-0011); the Transcript Module moved to `/transcript`. The Module registry itself is still ahead.

## Getting started

**Docker is the only supported way to run this app.** Running it and changing it both happen in
the container (see [Working on the code](#working-on-the-code)), so the one port, the one workspace
mount and the one registered Google redirect URI hold everywhere — there is no native path to keep
in sync with them.

1. Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/). It has to
   be **running**, not just installed — the whale in the menu bar stops animating when it is ready.
2. `docker compose up -d --build` — first run only; drop `--build` afterwards.
3. Open http://localhost:4317.
4. Configure the extraction provider and the Google connection in **Settings** (below).

`docker compose down` stops it. `restart: "no"` is deliberate: the app does not come back on its
own when Docker Desktop starts.

**[ONBOARDING.md](ONBOARDING.md) is the same path written for someone who has never used Docker
or Google Cloud** — send that, not this file, to anyone setting the app up for the first time.

Three things about the container are load-bearing:

- **Port 4317 is published, exactly.** Google matches the redirect URI character for character, so
  the one you registered has to be the one the server sends. Settings always shows the URI for the
  port in use, so if you do change `PORT`, register the URI it shows there.
- **`workspace/` is a bind mount, never a layer.** Runs and secrets stay on the host; the image
  holds no state. `workspace/` is gitignored, so a fresh clone has none and Docker creates it.
- **The published port binds to `127.0.0.1` on the host.** The app has no authentication
  ([ADR-0001](docs/adr/0001-local-first-single-user.md)), so it must not be reachable from the
  network. Inside the container the server listens on `0.0.0.0` (`HOST`), because a container's
  loopback interface is unreachable from the host — the host-side `127.0.0.1` binding in
  `docker-compose.yml` is what keeps it private.
Verified: image builds, container serves the UI and API, and a transcript dropped in the configured
Drive folder runs end to end with the mock provider, writing `meta.json` / `result.json` / `events.jsonl` through the mount.
Kubernetes and the EdgeScale cube are **untested** — there is no chart in this repo yet.

## Configuration

### Google (Tasks + Gmail drafts + Drive) — guided in the app

Open **Settings**. The Google card is the setup flow: the console steps in the order Google's own
console imposes them, each with a deep link, the scopes and redirect URI with copy buttons, and
**Check my setup**, which asks Google and names whichever piece is missing. Nothing to look up
here, and nothing in this README to hold in your head while you tab through a console.

Each person registers their own Google Cloud OAuth client. There is no shared client to ship —
this repo is public, so a committed client secret would be revoked, and there is no server to hold
one ([ADR-0007](docs/adr/0007-per-user-google-oauth-client.md)). Budget about ten minutes.

Two things worth knowing before you start:

- **All three APIs must be enabled** — Tasks, Gmail, and Drive — or the first run fails with a 403 rather than
  at connect time. **Check my setup** names which one, rather than leaving it to a run.
- **A Workspace account should choose Internal, and then none of this applies.** Internal needs
  no test users, shows no unverified-app screen, and does not expire. Google greys it out for
  personal accounts, which must use **External** + **Testing** — the only combination allowed
  without a verification review for the Gmail/Drive scopes — and that expires refresh tokens after seven
  days. The card asks which account you have and renders the matching steps.
- **The expiry estimate is earned, not assumed.** Settings shows when you last signed in, and only
  predicts the next expiry once Google has actually refused a grant. An Internal connection
  therefore never announces an expiry it will not have.

### Extraction provider


In Settings, pick a provider and paste its API key; the card links straight to that provider's key
page. Defaults: `gpt-5.2` (OpenAI), `claude-sonnet-5` (Anthropic), `google/gemini-3.7-flash`
(OpenRouter / Gemini). The model field is free text — correct it there if a default 404s.

`mock` returns `workspace/mock-result.json` and needs no key. It backs the hermetic test suite and
is the default in a fresh workspace, so an upload before any configuration produces a harmless
skip rather than an authentication error. It is not part of the onboarding path.

`ollama` runs the extraction against a model served locally, through Ollama's OpenAI-compatible
endpoint. Set the base URL in Settings (`http://127.0.0.1:11434` on the host,
`http://host.docker.internal:11434` when this app runs in a container and Ollama runs on the host);
no API key is needed. The default model id is `nemotron` — free text, so set whatever tag you have
pulled. **Untested against a live Ollama server:** the request shape is covered by unit tests, but
no local model has been run through it yet, and a 30B model needs more memory than a 16 GB machine
has.

### Intake

**Drive folder** — pick one Google Drive folder in Settings (**Drive transcripts** card). Every `.txt`, `.md`, `.json`, `.jsonc`, `.pdf`, `.docx`, or native Google Doc added there is polled (default 2 min) and becomes a Run. Ingested Drive `fileId`s are remembered in `workspace/state.json` (`drive.ingestedIds`, capped at 1000); files stay in Drive (`drive.readonly`). Unsupported types are ignored. `Sync now` runs one poll immediately.

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

Environment (set in the `Dockerfile`, not on the host): `PORT` (4317 — the Google redirect URI is
registered for this port; change both together), `WORKSPACE_DIR` (`/app/workspace`, the bind
mount), `HOST` (`0.0.0.0` inside the container; the host-side `127.0.0.1` binding in
`docker-compose.yml` is what keeps the app private).


## Workspace layout

All state lives on disk, no database:

```
workspace/
  config.json             settings (secrets redacted via the API, never echoed back)
  state.json              { drive: { ingestedIds, lastPollAt } }
  mock-result.json        mock-provider fixture
  runs/<runId>/
    meta.json             status machine: pending → extracting → creating-outputs → done | skipped | failed
    transcript.txt        normalized text fed to the LLM
    context.json          { meetingDate, attendees }
    result.json           ExtractionResult — persisted even for skips and output failures
    events.jsonl          one JSON line per event (extract_attempt, google_task_created, …)
```
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
- Secrets live in `workspace/config.json` (keep the workspace private). The API redacts them:
  GET returns only `set` + last-4 hints; PUT keeps stored values when a secret field is omitted.
- The server binds to `127.0.0.1` only.
- Mail can never be sent: `google/gmail.ts` contains no delivery call, and
  `tests/src/unit/draft-mime.test.ts` fails the build if one appears.
- The Settings page is the only place the app loads remote code (Google's Picker script at `https://apis.google.com/js/api.js`, fetched on click only). The per-pick access token is short-lived, never persisted, never logged, and carries all three scopes.
