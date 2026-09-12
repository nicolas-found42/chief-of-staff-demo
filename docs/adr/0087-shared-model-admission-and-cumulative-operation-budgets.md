# Shared model admission and cumulative operation budgets

The Meeting Wizard Architecture Review (F5, Stage 3, and MWR-023/024/025/026/027/028/058/064)
established that per-Runner Promise queues and request-local provider deadlines do not enforce
global admission or durable operation allowances. The settled resolution in
[issue #346](https://github.com/nicolas-found42/chief-of-staff-demo/issues/346)
specified default and configurable admission fairness, durable queue and deadline controls,
conservative token and money reservations, explicit owner extensions, cancellation generation
fences, and source-free reconstructable timelines. This record states how model admission and
budgets are governed; the implementation is
[issue #357](https://github.com/nicolas-found42/chief-of-staff-demo/issues/357).

## Admission and fair scheduling (MWR-023, MWR-024)

Every model call — initial attempts, retries, binding fallbacks, repairs, and regenerations
across all providers — enters one Shell-owned admission service:

- **Global concurrency cap.** Default maximum active provider attempts is 4, configurable to a
  positive bounded integer.
- **Two priority tiers.** Requests enter either `time-sensitive` (interactive or Brief) or
  `normal` (background extraction) queues.
- **Starvation prevention.** At most three consecutive time-sensitive admissions are permitted
  while normal work waits before the oldest normal request must be admitted.
- **Aged normal preference.** A normal request waiting 60 seconds or longer takes the next
  available slot immediately ahead of time-sensitive arrivals.
- **No preemption of active calls.** Active provider calls continue until completion, failure,
  or cancellation.
- **Slot release during backoff.** Provider backoff releases its admission slot so waiting
  requests can proceed, and re-acquires a slot when the backoff delay elapses.
- **Explicit queue age and processing limits.** Default queue-age limit is 30 minutes and
  processing deadline is 15 minutes, separately configurable. Exceeded limits fail explicitly
  rather than hanging.

## Cumulative operation budgets and conservative preflight (MWR-025, MWR-026)

All attempts under an operation share durable spend and token allowances:

- **Approved ceilings.** _Amended 2026-09-12 (#363): the USD 100 campaign figure below was the
  agent's recommendation under a delegated "your rec", and the owner has since declined to
  approve it. A validation campaign now takes its ceiling from the owner on the command line
  with no default: since #405 that is an account-balance floor (`--balance-floor`, USD 10.10
  today) the ledger's headroom is re-based to at every launch, and a price cap
  (`--price-cap`, 0.10 in / 0.20 out per million tokens today) no planned model may exceed;
  the constant remains only as the production Workspace ledger's seed pending a separate
  owner decision._ Campaign budget
  defaults to USD 100.00; whole Debrief and Brief
  operations default to USD 2.00 allowances with 4,000,000 input and 500,000 output token
  safety ceilings. Allowances do not reset across retries, restarts, or model variants.
- **Conservative preflight reservation.** Before each wire dispatch, conservative token
  requirements are estimated using UTF-8 byte bounds (`ceil(bytes / 1.5) + framing reserves`)
  plus output reserves; raw character counts are never used as token counts.
- **Context capacity check.** The complete request is checked against model context capacity
  before dispatch. Requests exceeding capacity fail fast; source and candidate text are never
  silently truncated.
- **Price evidence and grant verification.** Unknown pricing evidence or absent source
  lifecycle grants block dispatch.
- **In-flight charge retention.** Disconnected, aborted, or unobserved calls retain their
  conservative reservation as unverified spend; budget is never silently freed on failure.
- **Explicit owner extension.** Owners may extend operation allowance via explicit command
  binding expected record version; stale extensions fail with `ExpectedVersionConflictError`.

## Cancellation generation fencing and settle-before-retry (MWR-027, MWR-064)

- **Cancellation.** Cancelling an operation drains queued requests, aborts active in-flight
  calls via `AbortController`, increments the durable operation generation, and sets status.
- **Late-write rejection.** Callbacks arriving after cancellation or generation bump are
  fenced off: attempting to commit state or publish artifacts under an older generation
  throws `StaleOperationGenerationError`.
- **Settle-before-retry.** Retrying an operation waits for all active in-flight calls of the
  previous generation to settle before new attempts begin, eliminating race conditions.
- **Lock-free network operations.** Workspace file commit coordination is never held during
  network calls.

## Reconstructable timelines and source-free telemetry (MWR-028, MWR-058)

- **Reconstructable timeline.** Every attempt records queue wait, wire duration, token counts
  (estimated/observed), cost facts, model, binding, outcome, and validation verdict into a
  durable timeline store without retaining raw transcript text, names, or private quotes.
- **Corpus and load reporting.** Telemetry measures transcript token distributions, candidate
  density, duplicate-observation rate, repairs by validator, and dependency-path durations
  in sanitized, source-free summaries.

## Durability and recovery

The budget ledger and timeline store commit through verified same-directory rename and readback
verification. Constructor instantiation is lazy in memory; no files are written until the first
mutation or record occurs, preserving pre-cutover Workspaces under the #144 composition gate.
Simulated crashes and two successive recoveries verify exact state and ID preservation.
