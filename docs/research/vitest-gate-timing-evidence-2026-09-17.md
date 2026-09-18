# Vitest gate timing evidence

## What the timings mean

Vitest's verbose reporter emits one line per completed **test case**, not a separate file or suite timing. In the v5.0.0 source, `VerboseReporter.onTestCaseResult` appends `getTestCaseSuffix`; the base reporter formats `task.result.duration` rounded to integer milliseconds. Grouping those lines by file and adding their durations is therefore valid as **summed individual-test duration per file**, with rounding—not as measured file wall time. [1][2]

The sum does not include every phase of running a file: Vitest tracks collection, setup, environment and worker preparation separately from test execution. Tests may also overlap: files run in parallel by default, and tests within a file are sequential by default but can opt into concurrency. Consequently neither per-file sums nor sums across files establish elapsed suite time. For ordinary non-watch runs, the reporter's top-level `Duration` instead uses elapsed time between its run-start and run-end events. [2][3]

The repository selects the `threads` pool and sets both `testTimeout` and `hookTimeout` to `30_000`. `testTimeout` is a default **per-test** limit, not a deadline for a file, Vitest invocation or entire gate. The test package runs `vitest run`; the root `check` runs `check:static` alongside `test`, whose script first builds the shared package. A Vitest `Duration` in a gate log is thus not the complete `pnpm run check` wall duration. [4][5][6]

## Historical Phase 1 evidence

These are observations from the completed diagnosis, not new runs. The parent agent extracted retained local logs; those `/tmp` artifacts are ephemeral and are cited as provenance rather than copied here. [7][8]

- **Archived-session observation:** five saturated `pnpm run check` runs each exited 0; saturation used 16 load processes. The retained gate logs confirm **274 files / 3339 tests passing** each and contain no `EPIPE` or anchored `FAIL`/`✗` markers. [8][9]
- **Archived-session observation:** five saturated tests-only verbose runs also passed. Parsing each retained log recovered exactly **3339 test-case lines across 274 files**, including nested test names. [7][9]
- The largest **per-file sums of printed individual-test durations** across those five verbose runs were `source-search-pass-deadline` **20,078–20,098 ms**, `workspace-backup-command` **17,490–18,852 ms**, and `person-benchmark-comparison` **14,780–16,391 ms**. These are not file wall times. [7]
- The slowest individual case in each verbose run was the later-pass straggler test: **10,065; 10,060; 10,059; 10,058; 10,074 ms**. The SIGKILL recovery case measured **5,876; 5,700; 5,702; 5,605; 5,894 ms**. [7]
- Vitest's `Duration` summaries **inside the five full-gate logs** were **97.76; 98.37; 97.64; 94.38; 117.71 seconds**. These do not establish whole-gate wall duration; the earlier **80–87 seconds** claim is unsupported by these retained measurements. [8]

**Arithmetic inference:** comparing the configured 30-second default with SIGKILL's observed 5.605–5.894 seconds yields **5.09–5.35×**, not 9×. That is an observed timeout-to-duration ratio for this case—not guaranteed future headroom, nor a comparison against a whole gate. For the slowest observed individual case above, the ratio is approximately **2.98×**. [4][7]

**Conclusion:** Phase 1 **did not reproduce the historical symptom**, according to the archived session. Passing runs and these timings do not establish why it previously occurred or prove it cannot recur. **Root cause remains unknown.** [7][8][9]

## Sources

1. [Vitest verbose reporter documentation](https://vitest.dev/guide/reporters.html#verbose-reporter); [v5.0.0 verbose reporter source](https://github.com/vitest-dev/vitest/blob/v5.0.0/packages/vitest/src/node/reporters/verbose.ts).
2. [Vitest v5.0.0 base reporter source](https://github.com/vitest-dev/vitest/blob/v5.0.0/packages/vitest/src/node/reporters/base.ts): `getDurationPrefix`, `reportTestSummary`, `trackedFileTime`.
3. [Vitest parallelism documentation](https://vitest.dev/guide/parallelism.html).
4. [Repository Vitest configuration](../../tests/vitest.config.ts); [Vitest `testTimeout` documentation](https://vitest.dev/config/testtimeout.html).
5. [Test package scripts](../../tests/package.json).
6. [Root package scripts](../../package.json).
7. Retained tests-only logs: `/tmp/chief-diag-flake-run1.log` through `/tmp/chief-diag-flake-run5.log`; parent-agent extraction of completed Phase 1 runs.
8. Retained full-gate logs: `/tmp/chief-diag-gate-flake-run1.log` through `/tmp/chief-diag-gate-flake-run5.log` (ephemeral local artifacts); parent-agent extraction.
9. User-provided session history (2026-09-17), no file provenance. No new probes, tests or validation were run for this note.
