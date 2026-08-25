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
| Production image | `docker compose build`, boot, then `GET /api/health` | The pruned runtime image contains a working server and web bundle |
| Clean checkout | GitHub Actions on pushes to `main` | Clean installs, the gates above, coverage, and the production image boot |

The unit coverage gate measures `apps/server/src`, excluding the process bootstrap and the
test-only e2e seed seam. CI reports the result in its job summary and enforces the global lines
floor in `tests/vitest.config.ts`.

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
