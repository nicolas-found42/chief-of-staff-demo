# Incomplete Debriefs preserve required sections

A checked action core is prepared immediately and can become reviewable when required downstream
work fails, stops, or the owner requests early review. All current Debrief sections remain required
for completion, including coaching. Failed sections stay visibly unavailable rather than becoming
successful empty values. This preserves useful checked work without weakening the completion
contract, as specified in [issue #345](https://github.com/nicolas-found42/chief-of-staff-demo/issues/345).

An incomplete publication is permanently review-only. Manual Task Acceptance can freeze a checked,
selected and reconciled proposal after acknowledgment of missing content; later enrichment proposes
a revision or amendment and never changes accepted work. Ordinary execution can first publish a
complete revision, preserving the separately gated automatic-promotion path in ADR-0083.

This refines ADRs 0037/0061/0078 and extends ADR-0084. Independent section retries and regeneration
retain immutable dependencies and exclude rejected prose. The detailed technical contract and
migration/acceptance matrix live on the issue. This is a specification awaiting implementation.

## Implementation decisions (issue #361)

The implementation keeps every Debrief artifact inside the Run directory, so **no Workspace stored
format is added** and no Workspace migration is required; the `result.json` projection is simply not
written for a revision that never claimed completion, so a reader written before this change finds
no Debrief there rather than an apparently finished one.

- **The checked core is its own artifact** (`core-r<n>.json`), committed the moment the candidate
  accounting, checked facts, responsibility bindings, deduplication and final cardinality pass, and
  before a single downstream section is asked for. It carries the source text's checksum and the
  frozen context's checksum, and its own checksum covers every other field. The manifest records the
  core it was assembled from, so a revision that names a core it can no longer read fails closed.
- **Sections are one phase with one availability record each.** Ours come back from a single
  overview request plus a separate decision-status check, so a refusal there leaves six sections
  unavailable and a decision that could not be verified leaves decisions unavailable — while the
  checked Action Items stay validated work. `validated-empty` and `failed` are different states, and
  only the first is content.
- **Availability travels with the revision bytes.** A revision's `sections` are stored beside its
  result, so an interrupted preparation that a later reconciliation adopts still reads as the
  incomplete revision it was rather than being completed by adoption.
- **Exposure is one-way and refused as a replacement.** An incomplete revision is published only
  when the Run has no complete publication; it never moves the pointer over one. Its pointer records
  `reviewOnly: true`, no completion receipt is written, the Run reports failed with the unavailable
  sections named, and every later revision of that lineage inherits review-only.
- **Retry resumes the core, never the discovery.** A retry of an incomplete publication re-runs only
  the sections; the stored core is reused while its source and context checksums still match, and a
  changed source or context requires a new core instead.
- **Consumers read availability rather than absence.** The Module's detail carries the revision's
  section states, the review surface renders an unavailable section as unavailable (never as "none
  recorded") and offers a retry, the Meeting list stops reporting an incomplete publication as a
  failed extraction, and `/email`, `/preview` and `/approve` refuse an incomplete revision outright,
  so no email authorization is introduced by early exposure. Locked previews and their digests are
  untouched.
- **Acceptance out of an incomplete Debrief is acknowledged or refused.** Materializing from an
  incomplete revision marks each Action Item's source review-only; promoting one requires
  `missingContentAcknowledged === true` (exactly that boolean), and the acknowledgment is recorded
  in the promotion decision. Automatic-promotion gating itself remains ADR-0083's and issue #360's.
