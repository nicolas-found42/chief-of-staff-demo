# Private Workspace backup and offline restoration

`scripts/workspace-backup.mts` is the operator workflow for issue #353. It never
starts the app, intake, synchronization, delivery or inference. The supported
deployment is one Docker app with an intact writable host mount. Stop that app
and any other writer before using the command. Keep the existing image available;
do not rebuild or regenerate the Workspace as part of preservation.

Use a new destination outside both the repository and Workspace, on storage with
space for the image archive and three Workspace copies. The destination is private
(0700): configuration, credentials, source material and diagnostic history are
copied deliberately. Do not upload it, attach it to an issue, or serve it as a web
root. Public command output contains only timestamps, counts and outcome labels.

## Capture

Record the selected app's container name and Workspace mount using `docker inspect`.
Stop that container with `docker stop --time 30 <container>`. Arrange to restart the
same unchanged container even if capture fails. While it is stopped, run:

```sh
pnpm exec tsx scripts/workspace-backup.mts capture \
  /absolute/workspace /private/new-baseline /absolute/repository stopped-container
```

The command checks running Docker writable mounts and open host handles before
and after copying. Unknown handles or inspection errors refuse the operation.
Known read-only Docker virtualization handles are recorded and permitted. A
running container whose recorded mount source does not exist on the host is a
Docker-managed volume stored inside the VM; it cannot be the Workspace, so it is
recorded in `unresolvedContainerMounts` instead of being resolved. Any other
inspection error, unexplained handle or work-Workspace writer refuses the capture.
This inspection assumes the supported single-app deployment; it is not a lock
against arbitrary host programs that might open files later. Disable external
supervisors that restart stopped writers, and do not run migrations or host writers
concurrently.

Every capture attempt owns `<destination>.partial` from the moment the destination
is accepted. A refusal there retains `failure.json` with the failed phase and the
private reason, while ordinary output only reports that the workflow refused. The
destination itself appears only after both restorations and the code-stability
check succeed, so a `.partial` directory is never a backup: keep it privately,
investigate, and use a new destination for the next attempt.

The private baseline contains:

- `backup/workspace/` and `backup/manifest.json`: exact file paths, byte counts,
  SHA-256 hashes, capture time and a canonical public-store inventory hash.
- `restored-1/` and `restored-2/`: two independently restored, byte-verified copies.
  Canonical Tasks, Lists, Action Items, cutover receipt, Meetings, Transcripts,
  processing ledger and deletion tombstones are read and compared without starting
  any application scheduler or connector.
- `provenance/`: tracked source archive at HEAD, binary working-tree diff including
  staged changes, untracked inputs, code inventory, actual stopped image/mount
  identity, saved image archive, the effective container invocation and quiescence
  checks and file checksums. `container.json` records the image reference,
  entrypoint, command, working directory, user, restart policy, published ports and
  environment variable names only — an environment value can carry a credential.
  The source archive includes the lockfile and tracked prompts/schemas/validators.
  Actual model configuration, source/context bytes and historical route/binding
  artifacts remain in the private Workspace. Missing historical provenance remains
  unknown.
- `result.json`: the completion outcome and explicit limits. It is written only
  after both restorations and code stability checks succeed.

Image identity does not prove which source checkout built it. The manifest records
that relationship as unverified. The saved image permits exact runtime retention;
the source archive, diff and untracked inputs permit reconstruction of the captured
checkout. They are distinct records. Ignored external evaluation corpora and source
files outside the Workspace are not implicitly included; campaign tooling freezes
those separately before inference.

Restart the original container with `docker start <container>` and verify its usual
`/api/health` response. A successful copy alone is not a deployment or a migration.

## Restore without activating

Stop writers to the current authoritative Workspace again. Its current bytes are
required independently of the backup. Restore into a new, absent directory:

```sh
pnpm exec tsx scripts/workspace-backup.mts restore \
  /absolute/current-workspace /private/new-baseline/backup /private/new-restore
```

The current implementation accepts the same captured point only. Any current
Workspace difference, including a removed deletion ledger, blocks restoration.
This deliberately refuses rollback while newer deletion, authorization or spending
history cannot yet be applied independently. Issue #356 owns the broader lifecycle
fence; this command does not overwrite current intent with an older snapshot.
Never substitute the backup itself for the current authoritative Workspace to
bypass the comparison. A read-only isolated verification is not permission to
start the restored app or send its content outward.

The restored directory becomes visible only after complete inventory and canonical
checks. It is private (0700). Existing destinations are refused. `.partial`
directories retain interrupted evidence and are not accepted backups. Preserve
them privately, investigate the failure, and use a new destination for another
attempt; there is no destructive automatic cleanup or guess at completion.
A refused restoration writes neither the destination nor the current Workspace and
says so on stderr; because its causes are reproducible from the same two inputs
(corrupt or stale backup, changed current state), it retains no separate receipt.
The capture-side `.partial` receipts are the recorded failure evidence for the
workflow.

No Workspace format is changed by this workflow. It verifies existing canonical
authority, including a cutover bundle over stale per-file records, without rewriting
IDs or reconstructing missing history. Backup coverage ends at `capturedAt`;
subsequent changes are outside that recovery point. No zero-loss, host-crash or
power-loss guarantee is claimed. Before later format activation, repeat capture
and restoration, retain a compatible reader/image, and state any post-backup loss
interval explicitly. Never activate a stale backup before current lifecycle fences.

## Verification evidence

The public-store/HTTP tests in `tests/src/migration/workspace-backup.test.ts`
exercise nonempty accepted/current Task history, dismissal, completion, Trash,
permanent deletion, changed source, missing/truncated files, incompatible manifests
and process termination around publication followed by two recoveries. The command
test uses controlled Docker/lsof executables at the OS boundary and a real Git
repository: it covers recorded read-only Docker handles, unexplained or
incomplete handle records, retained private failure receipts and the recorded
image/code provenance. It does not stand in for actual host evidence.

`tests/e2e/workspace-backup.spec.ts` renders the built Tasks page over actual Tasks
HTTP reads of two restores. It composes no connector or scheduler, refuses writes,
and blocks nonlocal browser requests. This verifies an isolated reading journey,
not live semantic quality or outward-delivery acceptance. Retain actual deployment
mount/quiescence and backup evidence privately alongside these controlled tests.
