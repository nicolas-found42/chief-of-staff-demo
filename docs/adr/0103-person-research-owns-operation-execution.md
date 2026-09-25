# Person Research owns operation execution

Person Research is the deep owner of one Person Research Operation's identity, activity fence,
checkpoints, spend and cancellation billing, conclusion, and retained evidence. The Queue remains
the durable scheduler and persistence projection: it dispatches or resumes accepted work, stores
the owner checkpoints, and projects owner facts into the unchanged `person-research.json` format,
but it no longer merges operation conclusions, decides when a cancellation bills, or publishes late
operation results. A resumable checkpoint or current operation identity continues the same
operation; a completed operation without a checkpoint is followed by a new identity, preserving
its conclusion and evidence as history. This deepens ADR-0063, ADR-0074, ADR-0075, and ADR-0087
without superseding their continuity, completion-condition, checkpoint, or cancellation-generation
rules, and introduces no alternate adapter.
