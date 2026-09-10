# Workspace records commit by verified rename under one coordinator

The Meeting Wizard Architecture Review (F1, and MWR-002/005/006/012) asked how much
durability the file-backed Workspace actually offers before publication, identity
and promotion work is built on top of it. The settled operating contract in
[issue #339](https://github.com/nicolas-found42/chief-of-staff-demo/issues/339)
chose process and container recovery on an intact writable mount plus tested backup
restoration, with host-crash and power-loss durability left unclaimed. This record
states how a record is committed under that boundary; the implementation is
[issue #354](https://github.com/nicolas-found42/chief-of-staff-demo/issues/354).

Every Shell-owned record commit goes through `apps/server/src/engine/commit.ts`:

- **One record, one rename.** Bytes are written to a unique temporary sibling in the
  target's own directory and renamed over the target, so a reader sees the old record
  or the new one and a refused write leaves the committed record authoritative.
  No multi-file transaction is claimed, and none may be inferred from a rename.
- **Read back, then publish.** The bytes at the destination are compared with the
  committed buffer before the commit returns. A publish that does not match is an
  integrity failure rather than a success, which is what makes a half-written
  temporary or another writer's bytes visible instead of silent.
- **Immutable identities replay, never replace.** A record with a fixed identity
  accepts exactly its own bytes again; different bytes under the same identity are an
  integrity error. A mutable record carries a `generation` that every write advances,
  so a caller that held an older generation can be refused instead of overwriting a
  change it never saw.
- **One critical section per record.** `createWorkspaceWriter` serializes writers of
  the same path for callers that must hold a decision across an `await`; competing
  writers of one record queue, and a nested write of the record already inside the
  section is refused rather than deadlocked.
- **Corruption is refused, not narrowed.** A record that exists and cannot be read as
  what it claims to be raises a typed integrity error. A truncated final line in an
  append-only log is the one damaged shape a crash explains, because the record's
  earlier state was already committed; a damaged interior line means the log lost
  evidence it once held, so it is refused rather than skipped. Product reads fail
  closed on integrity errors, and a damaged record must not stop the other records
  from being listed or recovered.

No `fsync` is performed. The claimed durability is recovery of the process or the
container on an intact mount, where the page cache survives either; syncing would buy
nothing for that claim and would not establish the power-loss durability that stays
unclaimed. Verifying the same-filesystem rename assumption on a deployment's actual
mount belongs to the campaign baseline in
[issue #363](https://github.com/nicolas-found42/chief-of-staff-demo/issues/363).

**Alternative B escalation triggers (MWR-002).** File storage stays while it
converges. A transactional record store and durable graph is investigated only
against recorded evidence of one of: a reproducible non-convergent failure through a
supported fault path; a lost accepted owner decision; unresolvable write ambiguity;
conflict frequency that ordinary use makes unacceptable; or recovery whose complexity
grows with independent durable units. Uneconomic long-source checking is a separate
measured trigger for selective context, not for storage. None of these is asserted
today, and none is excluded.
