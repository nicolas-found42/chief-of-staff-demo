# Debrief publication verifies durable work

A local Debrief Publication becomes complete only when the Module verifies its immutable result,
expected Action Item mappings and review context against committed records. File presence and Run
status cannot establish that invariant. Recoverable preparation and original Task Acceptance
receipts preserve work across interrupted writes without repeating model inference or applying a
new retry decision, as specified in
[Specify durable Debrief publication and Task promotion recovery](https://github.com/nicolas-found42/chief-of-staff-demo/issues/344#issuecomment-5624158213).

Retain file storage with serialized, version-checked updates and a canonical Task generation that
commits acceptance with its relationship. This trades additional reconciliation machinery for
avoiding a second persistence system; reproducible unsafe recovery or excessive coordination cost
reopens that choice. It refines ADR-0058 and makes ADR-0061's completion condition explicit while
preserving ADRs 0080–0083, original IDs, owner decisions, source deletion intent and accepted work.

The supported promise remains process/container recovery on an intact writable Workspace mount
plus restoration to a tested backup point. Host-crash and power-loss durability remain unclaimed.
Local publication is separate from ADR-0053's email operation and grants no outward delivery
permission.

The implementation is
[issue #358](https://github.com/nicolas-found42/chief-of-staff-demo/issues/358).
`apps/server/src/modules/meeting-debrief/publication.ts` owns the operation record, the immutable
revision and its manifest, the publication pointer and the completion receipt, and one reconciler
that ordinary extraction, retry, regeneration, the restart sweep and the terminal publication
sweep all enter. The order it enforces is the contract: the operation is reserved before any
inference; context, result and mappings are committed before the manifest that marks them
prepared; the pointer is written only after the prepared revision verifies; and the Run reports
done only after the Module reads the committed chain back. A Run that is interrupted between the
result and its marker adopts those exact bytes on the next reconciliation with no model call, and
accepted bytes that no longer match their receipt are an integrity failure rather than a
regeneration under the old identities.

**No Workspace stored format is added.** Every artifact here lives inside the Run directory
beside the `result.json` builds already write, and that projection is still written after the
pointer, so an older build still finds a Debrief where it always did and a Run written before
this protocol still reads as a legacy publication whose validation is explicitly unknown. No
migration, and no activation of a new canonical generation, is claimed by this change.

**Amended by [issue #385](https://github.com/nicolas-found42/chief-of-staff-demo/issues/385):**
the revision result also carries the extraction's candidate aliases (`candidateAliases`, aligned
with its Action Items). The result is the one artifact an interruption between it and its
manifest is guaranteed to leave behind, so the reconciler reads the aliases from those bytes for
a fresh and an adopted revision alike; before this, an adopted revision materialized alias-less
while a prepared one kept the aliases its manifest recorded. A result written without the field
still adopts as the alias-less revision it is, never as an integrity failure. No stored format is
added: the field lives inside the Run directory's revision result beside the rest of it.

Public Module and HTTP regressions cover zero-output and nonzero-output publication, a refused
mapping write, an interrupted preparation, damaged result and manifest bytes, a corrupt review
record that is refused rather than re-created, a missing projection, a missing completion receipt
and two recoveries; a reconciler-seam regression covers a refused manifest write directly, and
the browser journey asserts the published artifacts and that a Debrief never expires. The rows of
the #344 fault matrix that need truncation, disk-full, permission and process-kill injection at
each final write, live-source deletion during publication, and restoration from an older backup
remain with the campaign and recovery issues that own them; they are not claimed by #358.
