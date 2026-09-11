# Transcript deletion preserves accepted work

Transcript deletion removes source and unaccepted derived content while preserving accepted Task
content and its accepted evidence snapshot privately, with an explicit source-deleted marker.
Minimal identity and decision history survives redaction so cleanup cannot reverse owner decisions
or recreate work; full erasure of accepted content is a separate explicit owner action. This trades
blanket erasure for the preservation of accepted work, as settled in
[Authorize transcript routes and retention boundaries](https://github.com/nicolas-found42/chief-of-staff-demo/issues/341#issuecomment-5623607764).

Restoration applies current deletion intent before exposing an older backup or restarting work.
Diagnostic copies have bounded retention independent of canonical records; ADR-0061's product
non-expiry remains. Provider/model choices and disclosed route-retention exceptions are configurable
policy, separate from the models selected for a frozen development campaign. This preserves
ADR-0080's identities and accepted decisions while making removed evidence visibly unavailable.
These are accepted specifications awaiting implementation and validation, not a cleanup performed
on the current Workspace or a claim of remote erasure or host/power-loss durability.
