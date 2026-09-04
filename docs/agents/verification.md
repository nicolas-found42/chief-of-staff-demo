# Verification gates

Run the narrowest gate that covers the change while working, then the whole-tree gate before each
commit. Production-bundle changes also have to prove the container, because Docker is the only
supported way to run the app.

## Gate topology

| Granularity | Gate | What it proves |
| --- | --- | --- |
| One test file | `npm run test --workspace @chief-of-staff-demo/tests -- tests/src/<path>.test.ts` | The behavior at the seam currently being changed |
| TypeScript tree | `npm run typecheck` | Shared/server build references plus the web and test no-emit passes |
| Staged files | `.git/hooks/pre-commit` via `lint-staged` | Prettier on staged source/config/docs and ESLint on staged TypeScript |
| Whole tree | `npm run check` | Typecheck, lint, formatting, knip, and all unit tests |
| App behavior | `npm run check:all` | The whole-tree gate plus the Playwright suite |
| Prompt eval | `pnpm exec tsx scripts/run-debrief-eval-all.mts --models upstage/solar-pro4 --score` | Solar-pro4 debrief extractions on all 20 real fixture transcripts score clean against hand-written goldens |
| Production image | `docker compose build`, boot, then `GET /api/health` | The pruned runtime image contains a working server and web bundle |
| Clean checkout | GitHub Actions on pushes to `main` | Clean installs, the gates above, coverage, and the production image boot |

The unit coverage gate measures `apps/server/src`, excluding the process bootstrap and the
test-only e2e seed seam. CI reports the result in its job summary and enforces the global lines
floor in `tests/vitest.config.ts`.

## Prompt eval gate

Goldens live in `tests/fixtures/debrief-golden/` (expectations plus the input
transcripts). `upstage/solar-pro4` is the gate model; cheaper models (e.g.
`moonshotai/mercury-2.5-preview`) run as data points only, never as the gate.
The gate needs `OPENROUTER_API_KEY` and spends real API budget, so it is not
part of `check` — run it before commits that touch the debrief prompt and any
time eval outputs are refreshed. Goldens are hand-written from the transcripts,
never copied from model output; keyword matching is by intent (`any` groups in
each golden). A golden that the gate model honestly cannot meet means the prompt
needs work, not the golden — fix the prompt and re-run.

`pnpm run eval:score` re-scores the recorded runs and spends nothing; `pnpm run eval:lint` checks
the goldens themselves and is what to run after editing one. The format and the authoring method
are `tests/fixtures/debrief-golden/GOLDEN_FORMAT.md`.

### Running the eval

`scripts/run-debrief-eval-all.mts` fans the extraction out over models — every
transcript, every run, overwriting previous results
(`docs/research/debrief-eval-cli.md` holds the design rationale):

```sh
pnpm exec tsx scripts/run-debrief-eval-all.mts \
  --models upstage/solar-pro4,openai/gpt-oss-20b,mistralai/mistral-nemo --score
```

The run is done when it prints `done: N/N runs`, each model's score block has
run, and no `failed:` list follows. Results land in
`/tmp/debrief-gate/<author-slug>/`; `--score` chains the per-model scoring, so
a separate score pass is only needed when you skip it.
Every run lands exactly one file in the model dir: `<transcript>.debrief.json`
when the model answered (even schema-invalid), `<transcript>.error.json` when
every attempt failed — the scorer fails that golden with the recorded error.
The outcome a run did not produce is removed, so a re-run whose calls fail can
never be scored against the debrief output of an earlier run; should both files
turn up anyway, the scorer reads the error and ignores the debrief.

- Only `upstage/solar-pro4` gates a commit; every other model in `--models`
  is a data point.
- Calls stream: the first token must arrive within 30 seconds, and gaps
  between tokens may not exceed 30 seconds either — either way the call ends
  at the idle ceiling. A 120-second absolute ceiling bounds a slow trickle.
  A failed or timed-out run retries within a 60-second cumulative budget (max
  10 attempts) before printing the full model-boundary diagnostic. `HTTP 429`
  clusters mean back off with `--concurrency` (default 20).
- Free re-scoring of CLI output targets the per-model dir:
  `tsx scripts/score-debrief-eval.mts --all /tmp/debrief-gate/<model-slug>`.
  Bare `pnpm run eval:score` re-scores only the legacy `/tmp/debrief-gate/solar`
  dir from the old single-model runner — not CLI output.
- Flags and defaults: `--help` is authoritative.

## Pre-commit hook

The hook deliberately sees staged files only. Whole-tree typechecking, knip, unit tests, and
Playwright do not belong in it. After a fresh clone, install the configured hook explicitly:

```sh
npx simple-git-hooks
```

If the hook changes formatting, review the re-staged result and commit again. If it reports a lint
error, fix the staged file. `--no-verify` is not the escape hatch for a failing gate.

## Container check

Changes to the Dockerfile, runtime dependencies, server build, or web production bundle need this
additional check after `npm run check:all`:

```sh
docker compose build
docker compose up -d
curl --fail http://127.0.0.1:4317/api/health
docker compose down
```

The response must be `{"ok":true}`. Always bring the Compose project down, including after a
failed health check.
