# Automatic promotion is reserved under released evidence and a supported claim

Automatic owner promotion is decided from what was recorded *before* the model
was asked anything, and from a structured claim about the source relationship —
never from the live policy, a confidence number or an exact quotation. This
implements the contract settled in
[Define supported responsibility and automatic promotion](https://github.com/nicolas-found42/chief-of-staff-demo/issues/343#issuecomment-5623947689)
under the delivery of [issue #360](https://github.com/nicolas-found42/chief-of-staff-demo/issues/360).

**Three facts, deliberately three.** A Workspace records a *release* — the
dedicated fixtures and the live-output audit, named by a retained evidence
reference and its checksum — apart from the owner's Action Item Policy
preference. Passing code tests cannot write it, and a saved preference cannot
substitute for it. Once a release exists, the owner's *explicit enablement* is
recorded as its own act; an enablement recorded before the release conveys
nothing, so a release never resumes a preference saved earlier. The preference
remains what the owner asked for and is reported as saved, not as permission.

**Reserved, then read, never re-decided.** A Debrief operation records the
lineage claim and the authorization facts before inference. Eligibility is read
from that reservation, which travels with the materialized Action Item, so a
replay, a restart or a later enablement reach the verdict the operation was
reserved under; the live authorization is only compared against it at the
commit boundary, where any change yields review. Enablement therefore applies to
future eligible first extractions only: no backlog is swept and no recorded
review-only outcome is reconsidered.

**The claim is evidence, never permission.** A claim records the exact
obligation, its source speaker and statement turn, the proposed performer and
basis, the relationship (self-commitment, accepted-request, request,
reported-commitment, shared, unresolved), the assignment and acceptance turns,
later completion/cancellation/reassignment/qualification, unresolved reasons, and
the contract binding of source revision, checksum, frozen context and validator
version. Only the performer's own commitment or a request they unambiguously
accepted for that obligation can authorize; a judgement whose own evidence
contradicts it becomes unresolved. Grounding proves the words were said, never
what they mean, which is why the live-output audit remains the gate on whether
the judgements are any good.

**Stored format.** This adds one stored record: `config.json:tasks.promotion`
(version 1) carrying the release and the enable/disable history. It is a strict
schema key defaulting to `restricted`, so a config written before it reads as
restricted and an older build refuses the config instead of ignoring the
restriction. The canonical TaskStore bundle format is *not* bumped: the two new
Action Item fields are optional additions whose absence reads as unknown and
therefore review-only. Activating the new record on a live Workspace is a
deployment step, and it requires the discipline in
[`docs/agents/workspace-backup.md`](../agents/workspace-backup.md): quiesce
writers, inventory and checksum, capture a private baseline, prove isolated
network-disabled restoration and a twice-repeated fault migration, and state the
post-backup loss interval. No such migration was run for this change; the live
step is not claimed.
