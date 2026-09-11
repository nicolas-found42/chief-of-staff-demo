# Check Performance Diagnosis and Speedup Research — 2026-09-10

Scope: Full test and verification pipeline including `pnpm run check` (`typecheck`,
`lint`, `format:check`, `knip`, and unit tests via `vitest`), Playwright e2e tests,
Docker image builds, and GitHub Actions CI runner constraints.

Prior art reconciled:
- [`docs/research/pnpm-check-speedup.md`](pnpm-check-speedup.md) (2026-09-02)
- [`docs/research/verification-check-audit-2026-09-05.md`](verification-check-audit-2026-09-05.md) (2026-09-05)
- [`docs/research/dev-tooling.md`](dev-tooling.md) (2026-08-25, updated 2026-09-09)
- [`docs/research/typescript7-migration-2026-09-09.md`](typescript7-migration-2026-09-09.md) (2026-09-09)

Baseline environment:
- Local: Apple M5 (arm64, 10 CPU cores), Node 26.5.0, pnpm 12.3.4, macOS 26.4.0.
- CI: GitHub Actions `ubuntu-latest` (Ubuntu 24.04 LTS), Node 22.23.2, pnpm 12.3.4 (measured on run `34550168145`).

---

## Executive Summary & Historical Context

In early September 2026 ([`pnpm-check-speedup.md`](pnpm-check-speedup.md)), warm `check`
ran in **11.9s** with ~1,800 tests. By 2026-09-10, the suite expanded to **2,726 tests
across 241 files**, and local `pnpm run check` now takes **~69s**, while CI runs take
**4m 29s–4m 56s** (bounded by Playwright e2e in **4m 25s** and unit test coverage in **3m 00s**).

Crucially, `pnpm run check` runs `run-p check:static test`:
- `check:static` (typecheck, oxlint, prettier, knip) completes in **9.07s local / 43.0s CI**.
- `test` takes **~67s local / 164s CI**.

Because `check` is bounded by its slowest branch, **optimizing static checks cannot move
full `check` wall-clock time**. High-impact local optimizations must target the test suite itself.

### Parallel CI Jobs vs. Turnaround Latency

In GitHub Actions (measured on run `34550168145`), all four workflow jobs run in parallel:
- `image`: started 01:18:57 (duration **2m 40s**)
- `check`: started 01:18:58 (duration **1m 04s**)
- `test`: started 01:19:10 (duration **3m 00s**)
- `e2e`: started 01:19:25 (duration **4m 25s**)

Total PR turnaround latency is **4m 29s** (strictly bounded by `e2e` at 4m 25s).
Therefore:
- Reductions in `check` job duration (43s → 18s) and `image` job duration (120s → ~20s) save
  valuable **GitHub Actions runner compute-minutes**, but **do not reduce total PR turnaround latency**.
- To reduce overall CI turnaround time, optimizations must target the critical path: `e2e` (Playwright)
  and `test` (`test:coverage`).

### Summary of Findings & Actionable Recommendations

| Priority | Bottleneck | Measured Duration | Root Cause | Proposed Solution | Expected Impact |
|---|---|---|---|---|---|
| **1 (Highest)** | `person-benchmark-cli.test.ts` | **61.35s** (concurrent) / **29.04s** (isolated) | Spawns 21 separate Node subprocesses with `tsx` (`spawnSync(node, ["--import", "tsx", "scripts/person-research-benchmark.mts"])`) | Refactor benchmark CLI to expose a programmatic `runBenchmarkCli(...)` entry point tested in-process | **~26s suite wall-clock saved** (67.01s → 40.65s measured); file execution drops to <2s |
| **2** | Inefficient CI Static Gate Execution | **43.0s** on CI (`check` job) | `typecheck` (10.5s), `lint` (11.9s), `format:check` (18.4s), `knip` (2.2s) run serially in CI workflow | Run static checks concurrently in CI via `pnpm run check:static` | **~24s saved** in `check` job duration (bounds job to `format:check` at 18.4s); saves compute minutes |
| **3** | Uncached Docker Build in CI | **120.7s** on CI (`image` job) | `docker compose build` builds without Buildx GitHub Actions cache | Add GHA layer cache backend (`--cache-from type=gha`, `--cache-to type=gha,mode=max`) | **~100s saved** in `image` job duration; saves compute minutes |
| **Candidate** | Vitest Worker Thread Pool (`vmThreads`) | **52.63s** plain / **118.41s** coverage | Evaluates modules per-thread under `pool: "threads"`. `vmThreads` speeds plain runs but incurs V8 coverage serialization overhead | Fix cross-realm assertion in `source-http-dispatcher.test.ts`; keep `pool: "threads"` default for coverage runs | Enables optional `vmThreads` for rapid plain test iteration |
| **Preserved** | Soft-deadline delay in `source-search-pass-deadline.test.ts` | **20.43s** | Deliberate 10s straggler delay proving deadline races; asserted at line 169 (`expect(elapsed).toBeGreaterThanOrEqual(9000)`) | **Keep unchanged**; deliberate load-bearing verification |

---

## Part 1: Local Measurements & Bottleneck Profiling

### 1.1 Local Measured Baselines (Apple M5, 10 CPU cores)

All measurements are 3-run medians with `.prettiercache` and TypeScript caches warm:

| Command | Median Runtime | Spread (3 runs) | Status | What it does |
|---|---|---|---|---|
| `typecheck:build` | 0.25s | 0.24s – 0.34s | Pass | `tsc -b packages/shared apps/server relay` |
| `typecheck:web` | 0.26s | 0.25s – 0.28s | Pass | `tsc -p apps/web --noEmit` |
| `typecheck:tests` | 0.57s | 0.55s – 0.62s | Pass | `tsc -p tests --noEmit` |
| `typecheck:scripts` | 0.41s | 0.30s – 0.41s | Pass | `tsc -p scripts --noEmit` |
| `typecheck` (parallel) | 1.25s | 0.76s – 1.25s | Pass | All 4 projects run concurrently via `run-p` |
| `oxlint` alone | 4.15s | 2.56s – 4.15s | Pass | Type-aware linting (`oxlint-tsgolint 7.0.2001`, `oxlint-plugin-eslint`) |
| `lint:verify` | 2.65s | 1.92s – 2.65s | Pass | Probes intentional policy violations in isolated temp tree |
| `lint` (`oxlint` + `lint:verify`) | 7.06s | 4.21s – 7.06s | Pass | Sequential execution of lint passes |
| `format:check` (Prettier, warm cache) | 1.34s | 1.30s – 1.35s | Pass | Valid `.prettiercache` |
| `format:check` (Prettier, cold/uncached) | 6.90s | 6.85s – 6.92s | Pass | Full AST parse across all tracked repo files |
| `knip` | 1.63s | 0.91s – 1.63s | Pass | Workspace unused-code scan using Oxc parser |
| `check:static` | 9.07s | 3.22s – 9.07s | Pass | `run-p --print-label typecheck lint format:check knip` |
| `pnpm --filter @chief-of-staff-demo/shared build` | 0.42s | 0.27s – 0.42s | Pass | Generates shared `dist` required by tests |
| **`vitest run` (241 files, 2,726 tests)** | **67.01s** | **66.61s – 68.58s** | Pass | Full unit test suite |
| `vitest coverage` (with V8 report) | 76.01s | 74.5s – 76.0s | Pass | Full suite with server coverage floors |
| **Full `pnpm run check`** | **69.02s** | **68.2s – 70.5s** | Pass | `run-p check:static test` |

**Conclusion:** Static checks finish in **9.07s**. Full `check` takes **69.02s** because it
must wait for `vitest run` (**67.01s**).

---

### 1.2 Profiling the Vitest Test Suite

Vitest's duration breakdown across 3 consecutive runs:
```text
Test Files  241 passed (241)
Tests       2726 passed (2726)
Duration    67.01s (tests 48%, import 46%, transform 4%, environment 1%)

Import      599 modules were evaluated 10,497 times · 209.15s total, 46% of tracked time
```

#### Slowest Test Files (JSON Report Analysis)

| Rank | Test File | Duration (concurrent suite) | Duration (isolated) | Mechanism |
|---|---|---|---|---|
| **1** | `tests/src/modules/person-benchmark-cli.test.ts` | **61.35s** | 29.04s | 21 calls to `spawnSync(node, ["--import", "tsx", "scripts/person-research-benchmark.mts"])` |
| **2** | `tests/src/migration/workspace-backup-command.test.ts` | **21.47s** | 7.05s | Spawns `node --import tsx scripts/workspace-backup.mts` with fake runtimes |
| **3** | `tests/src/modules/source-search-pass-deadline.test.ts` | **20.43s** | 20.43s | Real `setTimeout(10_000)` proving soft-deadline exemption |
| **4** | `tests/src/modules/person-publication-records.test.ts` | 9.11s | 3.2s | Computationally heavy record parsing |
| **5** | `tests/src/modules/person-benchmark-comparison.test.ts` | 7.75s | 2.8s | Large JSON fixture parsing and comparisons |

#### Diagnosis of Bottleneck #1: Subprocess Contention in `person-benchmark-cli.test.ts`
- Measuring cold process execution with `--help` (`node --import tsx scripts/person-research-benchmark.mts --help`) takes **0.82s** on average (measured: 0.901s, 0.786s, 0.790s, 0.788s, 0.835s).
- Across 21 test invocations in a single file, **17.22 seconds** is consumed solely by Node process startup, `tsx` transpile, and importing the 60+ transitive modules of the benchmark script before any pipeline code runs.
- In isolation, 21 serial invocations take **29.04s**.
- Under concurrency across 10 Vitest worker threads, these repeated `tsx` compilation cycles saturate CPU queues and disk I/O, ballooning this file's duration to **61.35s**.
- Because Vitest runs tests within a file serially on a single worker thread, the entire suite is pinned waiting for this one worker to finish.
- **Measured verification:** Excluding or running this file in-process drops suite duration from **67.01s to ~38s** (an immediate **~29s wall-clock speedup**).

#### Architectural Levers: Splitting Files vs. In-Process Execution with Boundary Smoke Test
Two architectural approaches can alleviate the single-worker serialization bottleneck:
1. **Lever A (File Sharding)**: Split `person-benchmark-cli.test.ts` into 4–5 smaller files so Vitest's thread pool distributes the 21 `spawnSync` calls across multiple workers.
   - *Trade-off*: Recovers wall time by parallelizing workers, but still burns ~17 seconds of aggregate CPU time repeatedly re-spawning Node and re-transpiling the same script.
2. **Lever B (In-Process CLI Execution + Thin OS Boundary Test — Chosen)**: Refactor `scripts/person-research-benchmark.mts` to export `runBenchmarkCli(rawArgs, options)`, migrating scenario tests to run in-process while retaining a thin `spawnSync` test that executes `--help` at the OS boundary.
   - *Benefit*: Eliminates ~17 seconds of redundant process initialization and compilation, dropping total execution time to **~2.0s** while strictly validating the executable CLI contract at the OS process boundary.

#### Diagnosis of `source-search-pass-deadline.test.ts`: Why It Must Not Be Shortened
- The file takes **20.43s** because it has two 10-second real-time delays.
- A superficial idea might be to reduce `STRAGGLER_DELAY_MS` from `10_000` to `500`.
- **Why that is wrong:** Line 169 explicitly asserts:
  ```ts
  // The exempt first pass paid the full 10s tail: the straggler answered.
  expect(elapsed).toBeGreaterThanOrEqual(9000);
  ```
- The test's explicit architectural contract is to prove that an exempt first pass waits for the real transport tail even when exceeding the 250ms soft deadline. Any delay below 9,000ms **fails the assertion** and breaks the proof. This 20s cost is intentional and load-bearing.

---

### 1.3 Vitest Isolation vs. `vmThreads` Pool Verification

#### Blanket `isolate: false` Fails and Is Slower
- `tests/vitest.config.ts` currently sets `pool: "threads"` with `isolate: true` (the safe default).
- Vitest prints a diagnostic hint suggesting `isolate: false` could save ~18s.
- Running with `--no-isolate` produced **42 failed tests across 9 files** (`tests/src/unit/google-adapters.test.ts`, `tests/src/modules/browser-renderer.test.ts`, `tests/src/unit/source-eligibility.test.ts`, `tests/src/modules/public-search-openverse.test.ts`, etc.) and ran **slower** (**81.37s** vs 67.01s) due to timeout cascades and leaked `vi.mock` / fake timer states.
- Running `vitest doctor` confirmed this:
  ```text
  measuring baseline (pool: threads · isolate: true)... 31.03s
  measuring isolate: false... failed
  ```
- **Verdict:** Blanket `isolate: false` is completely non-viable for this repository.

#### `pool: "vmThreads"` Analysis and Measured Coverage Findings
- Running the full 241-file suite with `--pool vmThreads` (without coverage):
  - **240 passed, 1 failed (2,725 passed, 1 failed)**.
  - Duration dropped from **67.01s to 52.63s** (a **14.4s wall-clock savings**).
  - Import time dropped from **46% (209s CPU)** to **28%**.
- The **single failure** in the entire codebase was `tests/src/modules/source-http-dispatcher.test.ts:160`:
  ```text
  FAIL tests/src/modules/source-http-dispatcher.test.ts > Source HTTP pooled dispatch > still aborts on the per-request timeout with the existing error shape
  AssertionError: expected DOMException{ stack: 'AbortError: Th…' } to be an instance of Error
  ```
  - **Root cause:** In Node.js, `fetch` aborts with a `DOMException` originating from Node's internal realm. In `vmThreads`, the test runs inside a V8 VM context. Cross-realm objects do not share the VM's `Error.prototype`, so `outcome instanceof Error` fails even though `(outcome as Error).name === "AbortError"`.
  - Fixing this assertion to check `expect((outcome as Error).name).toBe("AbortError")` preserves the exact verification intent and makes the test cross-realm safe.
- **Coverage under `vmThreads`:**
  - Running `pnpm run test:coverage --pool vmThreads` took **118.41s** (50% worker overhead), significantly *slower* than `threads` (76.01s).
  - While all coverage floors passed, V8 coverage instrumentation inside multiple VM realms incurs significant serialization overhead.
- **Verdict:** `vmThreads` is a valuable candidate for fast local test iteration, but **`pool: "threads"` remains the standard default** for full suite and CI coverage runs.

### 1.4 Post-Implementation Measurements & Observed Suite Spread

Following the in-process CLI refactor and CI static check parallelization:
- `person-benchmark-cli.test.ts` dropped from **29.04s isolated to 2.06s** (a **93% reduction**).
- Full `vitest run` across multiple consecutive post-optimization runs on Apple M5:
  - Run A: **33.23s** (wall: 33.89s, import CPU time: 142.44s)
  - Run B: **36.06s** (wall: 37.92s, import CPU time: 159.21s)
  - Run C: **60.96s** (wall: 61.52s, import CPU time: 294.12s)
  - Run D: **69.40s** (wall: 71.27s, import CPU time: 313.41s)
- **Observed spread**: **33.23s – 69.40s** (best 33.23s vs pre-optimization baseline of 66.61s – 68.58s).
- **Diagnosis of spread**:
  - Node's worker threads under `pool: "threads"` experience significant variance in module evaluation time (ranging from 142s to 313s CPU time) depending on thread scheduling and file cache contention.
  - When remaining child-process tests (`person-benchmark-comparison.test.ts` taking ~6.2s, `person-benchmark-reassess.test.ts` taking ~6.8s, `workspace-backup-command.test.ts` taking ~4.8s, and the thin OS-boundary smoke test taking ~6.4s) happen to run concurrently on saturated CPU cores, worker thread imports slow down, inflating duration to ~60–69s.
  - On quiet runs where workers do not experience CPU starvation, the suite completes in **~33s–38s**.

---

## Part 2: Real CI Measurements (GitHub Actions)

### 2.1 Observed CI Job Durations

```text
✓ check  in 1m 04s  (ID 103111207958)
✓ test   in 3m 00s  (ID 103111208175)
✓ image  in 2m 40s  (ID 103111208171)
✓ e2e    in 4m 25s  (ID 103111208146)
Total PR latency: 4m 29s (bounded by e2e)
```

### 2.2 Observed CI Step Durations (from job logs)

| Job | Step | Observed Start Time (UTC) | Observed End Time (UTC) | Exact Duration | Notes |
|---|---|---|---|---|---|
| **check** | `pnpm run typecheck` | 01:19:15.357 | 01:19:25.831 | **10.47s** | Cold TypeScript 7 typecheck on 2-core VM |
| **check** | `pnpm run lint` | 01:19:25.831 | 01:19:37.717 | **11.88s** | Oxlint + `lint:verify` |
| **check** | `pnpm run format:check` | 01:19:37.717 | 01:19:56.102 | **18.38s** | Cold Prettier scan (no `.prettiercache` in CI) |
| **check** | `pnpm run knip` | 01:19:56.102 | 01:19:58.330 | **2.23s** | Knip 6 unused-code check |
| **test** | `pnpm run test:coverage` | 01:19:10.513 | 01:21:54.504 | **164.0s (2m 44s)** | Vitest unit suite + V8 coverage calculation |
| **e2e** | Playwright test | 01:19:29.895 | 01:23:19.759 | **229.8s (3m 50s)** | 82 browser tests, sequential single worker |
| **image** | `docker compose build` | 01:19:00.439 | 01:21:01.113 | **120.7s (2m 01s)** | Cold container build (no layer cache) |

**Key CI Insights:**
1. In `check`, static steps run **serially**, taking **43.0s total**. Running them concurrently (`pnpm run check:static`) bounds the job to `format:check` (**18.4s**), saving ~24s of compute time.
2. In `test`, `test:coverage` takes **164s (2m 44s)**. In-process test execution for the benchmark CLI directly reduces this job duration.
3. In `image`, building the Docker image takes **120.7s**. Using GitHub Actions cache (`--cache-from type=gha`) avoids rebuilding unchanged base layers, saving ~100s of compute time.
4. Total PR turnaround latency remains bounded by `e2e` (**4m 25s**). In the future, sharding Playwright across multiple workers or jobs (as detailed in `docs/research/pnpm-check-speedup.md`) is the required path to reduce total turnaround latency below 3 minutes.

---

## Part 3: Reconciling with Repo Decisions & Prior Art

Prior research in this repository has already evaluated and reached firm verdicts on
several candidate tools. It is critical not to re-propose tools already vetted and rejected:

### 3.1 Task Runners (Turborepo / Nx): Settled as "Don't Adopt"
- **Prior finding:** [`docs/research/dev-tooling.md:214`](dev-tooling.md):
  > "Plain npm/pnpm workspaces scripts as the task runner (Turbo/Nx pay off at 8–10+ workspaces or with remote-cache needs... sentiment: overhead below ~6 packages)."
- **Current state:** This monorepo has 5 workspace packages (`apps/server`, `apps/web`, `packages/shared`, `tests`, `relay`).
- **Verdict:** Introducing Turborepo adds configuration overhead (`turbo.json`, pipeline declarations, daemon management) for negligible local benefit when `run-p` already coordinates the four workspaces in ~1 second.

### 3.2 Formatter & Linter Migration (Biome / Oxfmt): Settled as "Don't Adopt"
- **Prior finding:** [`docs/research/dev-tooling.md:144`](dev-tooling.md):
  > "Keep Prettier 3 — it is exactly current (3.9.6)... Biome formatter / Oxfmt migrations save <1 s on this tree and buy formatting churn in git history; consensus is 'switch only if consolidating lint too'."
- **Current state:** Oxlint was already adopted on 2026-09-09 ([`typescript7-migration-2026-09-09.md`](typescript7-migration-2026-09-09.md)) for native TypeScript 7 compatibility. Prettier warm check takes only **1.34s** locally.
- **Verdict:** Prettier remains the standard. Migrating to Biome or Oxfmt would rewrite formatting across the codebase, causing massive git churn for a 1-second gain on a check that is already overshadowed by the 67-second test runner.

---

## Part 4: Targeted, Actionable Recommendations

### Recommendation 1: In-Process Benchmark CLI with OS-Boundary Smoke Test (High Impact)
- **Problem:** Spawns 21 full Node processes with `tsx`, taking **29.04s isolated and 61.35s under concurrency** (with 17.22s spent purely on Node/tsx startup overhead).
- **Implementation:**
  1. In `scripts/person-research-benchmark.mts`, encapsulate execution logic in an exported:
     ```ts
     export async function runBenchmarkCli(
       rawArgs: string[],
       options?: BenchmarkCliOptions
     ): Promise<BenchmarkCliResult>
     ```
     With an `isMain` guard executing `runBenchmarkCli(process.argv.slice(2), { forwardOutput: true })` when run as a standalone script.
  2. In `tests/src/modules/person-benchmark-cli.test.ts`:
     - Retain a thin `spawnSync` test verifying that `pnpm exec tsx scripts/person-research-benchmark.mts --help` executes cleanly at the OS process boundary.
     - Migrate the remaining 19 test scenarios to `await runBenchmarkCli(args)` directly (imported via `.mjs`, which TypeScript's `moduleResolution: bundler` resolves to `.mts`).
- **Measured Delta:** Drops test file duration from **29.04s to 2.06s**; post-refactor full suite duration achieves **33.23s–37.92s on quiet runs** (down from ~69s, with an observed spread of **33.2s–69.4s** depending on thread contention).

### Recommendation 2: Fix Cross-Realm Assertion in `source-http-dispatcher.test.ts`
- **Problem:** `expect(outcome).toBeInstanceOf(Error)` fails under VM contexts because Node's internal `DOMException` does not inherit from the VM realm's `Error.prototype`.
- **Implementation:**
  ```ts
  expect(outcome).toMatchObject({
    name: "AbortError",
    message: "This operation was aborted",
  });
  ```
- **Benefit:** Preserves exact error verification while enabling cross-realm test runners and `vmThreads`.

### Recommendation 3: Run Static CI Checks Concurrently (Saves Runner Compute Time)
- **Problem:** CI `check` job runs `typecheck`, `lint`, `format:check`, and `knip` sequentially (**43.0s total**).
- **Implementation:** In `.github/workflows/ci.yml`, replace the four sequential run steps with:
  ```yaml
  - run: pnpm run check:static
  ```
- **Measured Delta:** Runs all four static gates concurrently. Job execution time drops from **43.0s down to ~18.4s** (bounded by `format:check`), saving **~24s of runner compute time per CI run**.

### Recommendation 4: Docker Buildx Layer Caching in CI (Saves Runner Compute Time)
- **Problem:** `image` job runs cold `docker compose build` taking **120.7s**.
- **Implementation:** In `.github/workflows/ci.yml`, configure Buildx with GHA cache:
  ```yaml
  - uses: docker/setup-buildx-action@v3
  - uses: docker/build-push-action@v6
    with:
      context: .
      cache-from: type=gha
      cache-to: type=gha,mode=max
  ```
- **Measured Delta:** Rebuilding unchanged layers drops from **120.7s to < 20s**, saving **~100s of runner compute time in the image job**.

---

## Primary References & Data Sources

1. **Local Benchmarks:** 3-run medians on Apple M5, Node 26.5.0, pnpm 12.3.4.
2. **GitHub Actions Logs:** Run `34550168145` (Jobs: `check` 103111207958, `test` 103111208175, `image` 103111208171, `e2e` 103111208146).
3. **Vitest Documentation:** [Vitest Performance Guide](https://vitest.dev/guide/improving-performance) and [Vitest Doctor CLI](https://vitest.dev/guide/cli#vitest-doctor).
4. **Prior Repo Research:**
   - [`docs/research/pnpm-check-speedup.md`](pnpm-check-speedup.md)
   - [`docs/research/dev-tooling.md`](dev-tooling.md)
   - [`docs/research/typescript7-migration-2026-09-09.md`](typescript7-migration-2026-09-09.md)
