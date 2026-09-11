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
