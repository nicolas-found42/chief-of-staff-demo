# Meeting context requires evidence and preserves history

A Transcript associates automatically only through a trusted occurrence link or an existing
owner-confirmed association; filename, title, time and speaker heuristics offer review candidates.
Relative dates require an evidenced meeting date and recorded or confirmed meeting timezone, with
no automatic Workspace-timezone fallback. This accepts additional review and unresolved timing to
prevent weak matching evidence from becoming a wrong owner or deadline, as settled in
[Define association confidence and meeting-time evidence](https://github.com/nicolas-found42/chief-of-staff-demo/issues/342#issuecomment-5623740742).

Each extraction preserves its source, association, time and identity context. Later corrections
create explicit revisions or amendment proposals rather than rewriting historical evidence or
accepted Tasks. Legacy history with missing provenance remains visibly unknown; migration cannot
retroactively confirm it from current Calendar facts or settings.

This refines ADR-0050's weak-signal association path while preserving durable Meetings and separate
Brief/Debrief workflows, and extends the preservation boundaries in ADR-0080/0081. The linked ticket
owns the detailed contract and acceptance histories. These are accepted specifications awaiting
implementation and validation, not claims about current automatic matching or saved-data recovery.
