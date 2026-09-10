# Action Item identity survives proposal revisions

Action Items retain opaque Workspace identities while proposal revisions, source observations and
reconciliation decisions preserve how extracted commitments change. Exact persisted mappings make
retries repeatable; display fields and semantic similarity cannot establish identity or erase an
owner decision. This accepts extra reconciliation review to protect distinct obligations and
accepted work, as specified in
[Define Action Item identity and reconciliation across revisions](https://github.com/nicolas-found42/chief-of-staff-demo/issues/340#issuecomment-5623376786).

A correction to a pending proposal requires explicit revision selection before promotion. A later
apparent recommitment requires the owner to choose historical evidence or distinct new work;
neither extraction nor reconciliation restores dismissals, edits accepted Tasks or changes their
completion state. Records linked by the owner remain identifiable as non-promotable reconciled
history, and a stale review command must preserve committed intent or report a conflict.

This extends ADR-0053/0054's Workspace ownership and accepted snapshots, and ADR-0078's clarification
that resetting legacy review arrays never resets canonical Action Item decisions. ADR-0037's
regeneration-only correction of generated content remains; its legacy positional-drop rationale
does not govern durable Workspace review. The detailed contract and acceptance histories belong
to the linked ticket. Existing IDs are never rekeyed by migration.

Implemented in [issue #355](https://github.com/nicolas-found42/chief-of-staff-demo/issues/355). Two
things the implementation settled that the specification left open. The checked handoff is part of
the entry's checked content, because the commitment and responsibility basis it records are what
review and automatic promotion read: two entries that agree on every displayed field and disagree
there are two entries. And the materialization index is **derived from the records** rather than
committed beside them — an index written as its own file is lost by the crash that follows the
records reaching the Workspace, and the replay would then propose every obligation a second time,
so each extraction-origin revision carries the key and the checksum of the entry that was checked.

The stored shape changes: Action Items carry proposal revisions, observations, decisions,
reconciliation and a version, Tasks carry a version, and the canonical bundle is format 3. Reading
an older record never writes: a proposal written before revisions existed is presented as revision 1
whose origin says honestly that the extraction artifact, candidate alias and evidence occurrence are
unknown. An older build reads a format-3 bundle as the records it already understood, so rollback
needs no restore. Activation still requires the quiesced capture the preservation contract sets out;
merging this change does not perform it.
