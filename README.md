# Chief of Staff Local Workflow

A local-first implementation of the "Chief of Staff Agent: Take Actions from
Transcripts" workflow. Drop a meeting transcript into a watched inbox and the
service extracts the tasks assigned to you, drafts emails, drafts business
plans, creates follow-up tasks, records every action in a tracking table, and
writes a completion notification — all as local files. The only network calls
made during a live run are LLM calls through OpenRouter.

The implementation consists of:

- `packages/contracts` — shared TypeBox schemas and TypeScript types.
- `packages/workflow` — the deterministic workflow engine: definition
  validation, reference resolution, template rendering, profile substitution,
  the iterator with bounded parallelism, the path dispatcher, manifests,
  events, and filesystem primitives (atomic writes, path containment, CSV).
- `apps/service` — the local companion service: Fastify API on 127.0.0.1,
  pairing and session auth, transcript watcher, claim lifecycle, recovery,
  pi agents (`@earendil-works/pi-*`), OpenRouter integration, JSONL telemetry.
- `apps/web` — the React UI published to GitHub Pages (hash routing, relative
  asset URLs, local-origin offline fallback).
- `reference/workflow-definition.json` — the immutable, vendor-neutral
  workflow definition (15 steps, revision 219) with its stored SHA-256.
- `tests` — Vitest unit/golden/contract/failure suites and Playwright e2e.

## Requirements

- Node.js >= 22.19.0
- An OpenRouter API key exported as `OPENROUTER_API_KEY` in the service
  process environment (live runs only; tests and replay mode never use it).

## Quick start

```bash
npm install
npm run build            # typecheck + compile packages + build the web UI
npm run dev:service      # start the local service on http://127.0.0.1:4317
npm run dev:web          # start the Vite UI on http://localhost:5173
```

The service prints a short-lived pairing code to its console. Open the UI,
enter the service URL, check the connection, pair with the code, then complete
the profile in Setup. Drop a `.txt`, `.md`, `.pdf`, or `.docx` transcript into
`local-workspace/inbox/transcripts/` (or upload it from the Runs page) and
watch the run appear.

## Scripts

```text
npm run dev            # service + Vite UI
npm run dev:service    # tsx watch apps/service/src/main.ts
npm run dev:web        # vite dev server
npm run typecheck      # tsc across all packages
npm run lint           # eslint
npm run test           # vitest: unit, golden, contract, failure (offline)
npm run test:e2e       # playwright (needs npm run build first)
npm run build          # compile all packages + static web bundle
npm run preview:web    # vite preview of the production bundle
npm run scan:banned    # case-insensitive banned-token scan (BANNED_VENDOR_TOKEN)
```

The banned-token scan reads `BANNED_VENDOR_TOKEN` from the environment and
fails when the variable is missing or empty. It scans every tracked file's
name and content, plus any directories passed as arguments (CI passes
`apps/web/dist` after the build). Any occurrence of the token fails the scan.

## Service modes

- `live` (default) — real OpenRouter calls through pi-ai's OpenRouter
  provider. Requires `OPENROUTER_API_KEY`.
- `record` — live calls plus redacted request/response records under
  `runs/<run-id>/llm/`. Developer-only: requires `--dev`.
- `replay` — no network; versioned fixtures under `fixtures/llm/` drive the
  pi agent loop through the faux streaming provider. Developer-only:
  requires `--dev`.

```bash
node apps/service/dist/main.js --workspace ./local-workspace --port 4317
node apps/service/dist/main.js --workspace ./local-workspace --mode replay --dev --fixtures fixtures/llm
```

## Local workspace layout

```text
local-workspace/
├── config/           profile.json, models.json, app.json
├── inbox/transcripts/
├── source/           processing/ processed/ failed/ (one dir per run)
├── calendar/events.json
├── gmail/drafts/     *.md with YAML front matter
├── tasks/            email-drafts/ business-plans/ my-tasks/
├── docs/strategy-and-planning/
├── notifications/    <run-id>-summary.md
├── tracking/actions.csv
├── runs/<run-id>/    manifest.json, events.jsonl, telemetry.jsonl, input/, steps/, llm/
└── service/          claims/, pairing state
```

## Live-run data disclosure

Live runs send transcript-derived content and the workflow prompts to
OpenRouter and the model provider selected by OpenRouter. No other
application data is sent remotely. The API key exists only in the service
process environment; the UI receives only a configured/not-configured
boolean.

## Security notes

- The service binds to 127.0.0.1 only, enforces an exact Origin allowlist,
  and requires a paired session token for every endpoint except health and
  pairing.
- Every filesystem read/write resolves through the workspace root with
  containment checks; artifacts are written atomically (temp file + rename).
- Telemetry and manifests never record prompts, completions, transcript
  text, tool arguments, subjects, addresses, or absolute paths.

## Opt-in live smoke test

With `OPENROUTER_API_KEY` set, run a minimal transcript through the live
OpenRouter path manually (cost-bearing, not part of CI):

```bash
node scripts/live-smoke.mjs --workspace ./local-workspace
```

The script runs the engine in live mode over a short transcript and reports
the run status and per-step usage without persisting any fixtures.

## Continuous integration

`.github/workflows/ci.yml` runs type checking, linting, the offline test
suites (replay mode, no LLM network access), the banned-token scans, the
static build, a dependency audit, and the Playwright suite. It never
receives an OpenRouter secret.

`.github/workflows/pages.yml` builds only the static web application and
deploys `apps/web/dist` to GitHub Pages with the official Pages actions.
The Pages build contains no API key, transcript, run log, profile, or
absolute local path.
