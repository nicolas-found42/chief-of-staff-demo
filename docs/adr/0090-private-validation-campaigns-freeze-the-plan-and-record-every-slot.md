# Private validation campaigns freeze the plan and record every slot

The evaluation CLIs measured a model by overwriting one output slot per
transcript, printing the produced action titles, owners and dates to the
console, and — when the final serialization failed — returning an error without
writing any terminal file. None of that supports the evidence the review
requires (MWR-017, MWR-019, MWR-020, MWR-021, MWR-022, MWR-057): a run whose
missing or failed slots can vanish from its denominator, whose cost cannot be
reconciled to its attempts, or whose ordinary logs carry a private meeting's
content is not a measurement.

A validation campaign is therefore a frozen plan plus an append-only outcome
log, and it is written down before the first dispatch.

## The plan is frozen before dispatch

A campaign manifest records, in one file written with exclusive create and
never rewritten:

- the source revision, the hash of the uncommitted diff, and the image
  identity the run started from;
- the frozen corpus revision (case ids and a content hash), the source/identity
  context, and fingerprints of the resolved prompt and result-shape schema;
- the extractor strategy label, every model with its route, binding policy and
  grant identity (never a credential), the campaign and per-operation budget
  allowances, and the parent of every slot's cold root.

Every planned slot — one case, one model, one arm, one repetition — is allocated
from that manifest with a unique id, root and budget operation id. Slot counts
derive from the frozen corpus revision and the protocol's dimensions; no
protocol counts cases from a constant. A later request that changes any frozen
fact is refused rather than recorded as the same campaign: the manifest's digest
covers the freeze facts and the slot list, so a changed configuration is a new
campaign.

## Every planned slot ends with exactly one outcome

The outcome log is append-only. A slot that already holds a terminal outcome is
never executed again and never overwritten — a manual recovery cannot replace a
failed cold slot — and its record carries the status (`success`,
`schema-invalid`, `failed`, `interrupted`, or `missing`), the reason, charged
attempts, retries, queue delay, processing and total time, cost, and the
artifact path. A slot the run never produced is closed as `missing` with a
reason; it stays in the denominator. Charged attempts and spend come from the
existing budget ledger, and queue wait, duration and cost flags from the
timeline store — the campaign reads those seams instead of counting a second
time.

A cold slot is one that starts under an empty, never-reused root with no request
checkpoints, so it can neither replay an earlier attempt's accepted artifacts
nor be mistaken for a resumed run. Dispatch goes through the application's own
extraction path with admission, the budget ledger and the timeline attached; a
campaign does not get a private shortcut past the controls it is measuring.

## The report measures what the plan holds

The report counts planned slots, not executed ones: nearest-rank p95
(`ceil(0.95·n)`) over successful processing durations, completion over every
planned slot, and total spend across failed and successful operations divided by
successful completions — undefined, not zero, when nothing succeeded. Estimated
and unverified charges are labeled rather than folded into a measured total.
Each semantic category carries its own numerator and denominator and reports
not-applicable at a zero denominator. Deterministic Golden scores and privately
retained blind human judgments are separate collections; an adjudication packet
never names the model or arm that produced the output.

Ordinary stdout stays content-free: slot position, model, arm, status, timing,
counts and cost only. Case ids, transcript text and produced actions belong to
the private manifest, artifacts and report beside it.

## Considered Options

- **Extend the existing eval CLIs with campaign flags.** Rejected: the CLIs'
  contract is a flat per-model directory the scorer reads, and their overwrite
  semantics are load-bearing for the Solar gate. The campaign harness reuses
  their extraction path, the terminal-artifact helper and the content-free
  progress renderer, and leaves the gate CLIs otherwise intact.
- **Record outcomes in a single mutable JSON document.** Rejected: a rewrite
  can lose a slot on a crash, and it invites replacing an outcome. One
  append-only line per slot with a duplicate rejection keeps the invariant
  checkable from the file alone.
- **Reference the corpus by path instead of a content revision.** Rejected: a
  path can be re-populated, so the same campaign id would silently measure a
  different corpus. The revision hash is frozen into the manifest and the slot
  counts derive from it.
- **Treat a missing slot as an absence.** Rejected: that is shrinking the
  denominator. `missing` is a recorded outcome with a reason, so the report can
  state incompleteness instead of omitting it.

## Consequences

Live dispatch stays an explicit, owner-authorized act: a non-mock provider needs
a source-lifecycle grant, an allow-live flag and the provider's credentials, and
the mock provider exercises the whole harness with zero spend. The 69-slot
baseline, the comparison and final protocols, human adjudication and the private
evidence remain external work owned by their tickets; this record defines how
they are measured, not that they passed. The Scorer keeps owning Golden
verdicts, the timeline keeps owning per-attempt telemetry, and a campaign adds
only the immutable plan and the complete outcome ledger.

## Amended 2026-09-12: the owner states the ceiling; a diagnostic mode ends a slot at its first failure

Two additions from the first live campaigns under #363
([PR #396](https://github.com/nicolas-found42/chief-of-staff-demo/pull/396),
[PR #400](https://github.com/nicolas-found42/chief-of-staff-demo/pull/400)):

- **The campaign ceiling is the owner's number.** The USD 100 ledger default was an agent
  recommendation the owner declined; a live campaign now requires `--campaign-allowance <usd>` and
  refuses to freeze or dispatch without it. An existing ledger keeps the allowance it was created
  with, so a second campaign on the same `--budget-root` shares one cumulative ceiling. At a zero
  allowance the ledger admits only free models. ADR-0087 carries the same note.
- **`--no-recovery` is a diagnostic mode, not the baseline protocol.** The application's recovery —
  the provider's binding ladder and backoff inside the ceiling, and the one repair round a validator
  rejection earns — blurs *why* a cheap model failed behind minutes of retries. Under `--no-recovery`
  the first failed call or rejected answer is terminal; the outcome carries a content-free `failure`
  record (stage, kind `model`/`validator`/`shape`, classification, HTTP status, invalid-item count),
  and the slot's private error file holds the specific complaint. A campaign run this way measures
  the pipeline's first failure per slot, which is the right signal for iterating prompts and code
  and the wrong one for claiming the application's completion rate; the manifest's code revision and
  the flag together say which was measured.

