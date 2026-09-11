import { randomUUID } from "node:crypto";
import type {
  ActionItem,
  ActionItemAmendmentSuggestion,
  ActionItemDecisionKind,
  ActionItemDecisionRecord,
  ActionItemDisposition,
  ActionItemMaterializationMapping,
  ActionItemOccurrence,
  ActionItemProposal,
  ActionItemProposalRevision,
  ActionItemReconciliation,
  ActionItemState,
  ActionItemVersions,
  AutomaticPromotionAuthorizationFacts,
  HandoffDependencyTarget,
  HandoffDependencyUnresolved,
  MeetingDebriefActionItem,
  MeetingHandoffRecord,
  ResolvedActionItemDependency,
  TaskResponsiblePerson,
} from "@chief-of-staff-demo/shared";
import {
  actionItemProposal,
  currentReconciliation,
  handoffDependencies,
  handoffNotes,
  latestProposalRevision,
} from "@chief-of-staff-demo/shared";
import type { TaskStore } from "./store.js";
import {
  MaterializationIntegrityError,
  materializationKey,
  outputEntryId,
  materializationIndex,
  payloadChecksum,
  resolveDependencyTargets,
  type CheckedEntryPayload,
  type CheckedOutputEntry,
} from "./materialization.js";
import { TaskValidationError, type TaskValidationErrorCode } from "./tasks.js";

/** One extraction's proposed commitments, as the Meeting Debrief hands them over. */
export interface ActionItemMaterialization {
  debriefRunId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to; null until one is placed. */
  meetingId: string | null;
  /** The immutable source revision the extraction read, when it is known. */
  transcriptObservedRevision?: number | null;
  transcriptChecksum?: string | null;
  /** The frozen context checksum this revision was checked under (#360). */
  contextChecksum?: string;
  actionItems: MeetingDebriefActionItem[];
  /**
   * The extraction pipeline's own candidate ids, aligned with `actionItems`.
   * Local accounting: they identify a checked entry, never a Workspace record.
   */
  candidateAliases?: (string | null)[];
  /**
   * The lineage reservation the Debrief recorded before it asked the model
   * anything (#358, ADR-0084). Automatic acceptance reads this rather than
   * re-deriving the answer from a queue that a zero-action extraction leaves
   * empty: `review-only` here means the operation was reserved while
   * automation was not authorized, and no later enablement authorizes it.
   * Absent means the caller has no reservation (an older writer, or a harness).
   */
  firstExtraction?: DebriefExtractionReservation;
  /**
   * Whether the published revision was exposed incomplete (#345, ADR-0085).
   * The fact travels with the record rather than being re-derived at promote
   * time: the publication a reader can see today is not evidence about the
   * revision this Action Item was checked against.
   */
  reviewOnly?: boolean;
}

/** The reservation one Debrief operation carries, as the Tasks side reads it. */
interface DebriefExtractionReservation {
  operationId: string;
  claim: "first" | "review-only" | "unknown";
  basis: string;
  /** When the operation was reserved; the authorization facts are dated by it. */
  reservedAt: string;
  /**
   * The automatic-promotion authorization facts captured with the reservation
   * (#360). A later release or enablement never rewrites them, so a replay and
   * a restart reach the verdict the operation was reserved under.
   */
  authorization: AutomaticPromotionAuthorizationFacts | null;
}

/** What an Action Item query narrows on. Everything is optional. */
export interface ActionItemQuery {
  state?: ActionItemState;
  debriefRunId?: string;
  transcriptId?: string;
  meetingId?: string;
}

/** One command's expected record version (#355). A stale command is refused. */
export interface ActionItemCommand {
  /** The `version` the caller read. Omitted means "whatever is current". */
  expectedVersion?: number;
  /** Who is deciding. This Workspace has one trusted local user. */
  actor?: string;
  /**
   * Set on a promotion of a review-only Action Item: the owner answered the
   * missing-content question, and the decision history records that they did
   * (#345 §3). Never inferred from the caller's silence.
   */
  missingContentAcknowledged?: boolean;
}

export interface WorkspaceActionItemsDeps {
  store: TaskStore;
  now?: () => Date;
  /**
   * The confirmed owner's Person Profile id, read live. An extraction that
   * resolved a commitment to that Profile proposes the owner as Responsible
   * Person; every other resolved Profile proposes itself, and an unresolved
   * one proposes nobody rather than guessing.
   */
  ownerProfileId?: () => string | null;
}

/**
 * The Workspace's Action Items (ADR-0053/0080, issues #177/#355).
 *
 * A Meeting Debrief produces these; it does not own them. Materialization is
 * the one write the Debrief performs here, and it is exact: each checked
 * output entry materializes under a versioned key, the key's mapping is
 * persisted beside the record, and a replay of that key returns the record it
 * already allocated — whatever has happened to it since. Reordering the
 * extracted array changes nothing, and two obligations that look identical are
 * still two records.
 *
 * Every other write is an owner command: it binds the record version it was
 * shown, appends to the decision history instead of rewriting it, and refuses
 * rather than guessing when a correction, a reconciliation or another command
 * has moved the record on.
 */
export class WorkspaceActionItems {
  private readonly store: TaskStore;
  private readonly now: () => Date;
  private readonly ownerProfileId: () => string | null;

  constructor(deps: WorkspaceActionItemsDeps) {
    this.store = deps.store;
    this.now = deps.now ?? (() => new Date());
    this.ownerProfileId = deps.ownerProfileId ?? (() => null);
  }

  /**
   * Record one Action Item per checked output entry. An entry already mapped
   * for this Debrief Run returns the record it allocated — with whatever
   * review decisions it carries — instead of a duplicate, and an entry whose
   * key exists with different bytes is an integrity failure rather than a
   * silent overwrite.
   */
  materialize(input: ActionItemMaterialization): ActionItem[] {
    const stored = this.store.readActionItems();
    const byKey = materializationIndex(stored);
    const byId = new Map(stored.map((item) => [item.id, item]));
    const entries = input.actionItems.map((proposed, index) =>
      this.checkedEntry(
        proposed,
        this.occurrenceOf(proposed),
        input.candidateAliases?.[index] ?? null,
      ),
    );
    /* The dependency map is resolved against the checked output itself, before
       anything is committed: an entry's target is another entry's identity, or
       the honest reason it has none. */
    const targets = resolveDependencyTargets(entries);
    const revision = nextRevision(
      stored.filter((item) => item.source.debriefRunId === input.debriefRunId),
      entries,
      input,
      byKey,
    );
    const at = this.now().toISOString();
    const materialized: ActionItem[] = [];
    const added: ActionItem[] = [];
    entries.forEach((entry, index) => {
      const entryId = outputEntryId(entries, index);
      const key = materializationKey(input.debriefRunId, entryId);
      const checksum = payloadChecksum(entry.payload);
      const existing = byKey.get(key);
      if (existing) {
        if (existing.payloadChecksum !== checksum) {
          throw new MaterializationIntegrityError(
            key,
            `entry ${entryId} was checked as ${existing.payloadChecksum} and is now ${checksum}`,
          );
        }
        const item = byId.get(existing.actionItemId);
        if (!item) {
          throw new MaterializationIntegrityError(
            key,
            `mapping points at Action Item ${existing.actionItemId}, which is not in the Workspace`,
          );
        }
        materialized.push(item);
        return;
      }
      const id = allocateActionItemId();
      const item = this.newActionItem({
        id,
        input,
        entry,
        entryId,
        key,
        revision,
        at,
        candidates: this.reconciliationCandidates(stored, input, entry.payload),
        targets: targets[index]!,
      });
      added.push(item);
      materialized.push(item);
    });
    if (added.length > 0) this.store.writeActionItems([...stored, ...added]);
    return materialized;
  }

  /**
   * Read-only join between one extraction's checked entries and the records
   * they materialized. The join is the persisted mapping — never a hash of the
   * content, which would change the moment an owner edits a proposal.
   */
  forExtraction(input: ActionItemMaterialization): {
    current: (ActionItem | null)[];
    earlier: ActionItem[];
  } {
    const currentItems = this.list({ debriefRunId: input.debriefRunId });
    const items = input.meetingId ? this.list({ meetingId: input.meetingId }) : currentItems;
    const byKey = materializationIndex(this.store.readActionItems());
    const entries = input.actionItems.map((proposed, index) =>
      this.checkedEntry(
        proposed,
        this.occurrenceOf(proposed),
        input.candidateAliases?.[index] ?? null,
      ),
    );
    const ids = entries.map(
      (_, index) =>
        byKey.get(materializationKey(input.debriefRunId, outputEntryId(entries, index)))
          ?.actionItemId,
    );
    const current = ids.map((id) => currentItems.find((item) => item.id === id) ?? null);
    return {
      current,
      earlier: items.filter((item) => !ids.includes(item.id)),
    };
  }

  /**
   * The queue's dependency references, resolved against every record the
   * Workspace holds — not merely the ones this read returned, because the
   * target of a reference is exactly the record a filter would hide.
   */
  dependencyReferences(
    items: readonly ActionItem[],
  ): Record<string, ResolvedActionItemDependency[]> {
    const resolved = actionItemDependencyReferences(this.store.readActionItems());
    return Object.fromEntries(
      items.flatMap((item) => {
        const references = resolved.get(item.id);
        return references ? [[item.id, references] as const] : [];
      }),
    );
  }

  /**
   * Stored order, which is materialization order: extraction order inside one
   * Debrief, and chronological across Debriefs because materializing appends.
   * Nothing re-sorts it — a queue that reshuffles itself when the model
   * reorders its output is the problem stable identities exist to avoid.
   */
  list(query: ActionItemQuery = {}): ActionItem[] {
    return this.store
      .readActionItems()
      .filter(
        (item) =>
          matches(query.state, item.state) &&
          matches(query.debriefRunId, item.source.debriefRunId) &&
          matches(query.transcriptId, item.source.transcriptId) &&
          matches(query.meetingId, item.source.meetingId),
      );
  }

  get(actionItemId: string): ActionItem | null {
    return this.store.readActionItems().find((item) => item.id === actionItemId) ?? null;
  }

  /**
   * Record that this Action Item became that Task. The one write outside a
   * review command, and deliberately narrow: the proposal, the evidence and
   * the source are untouched, so the queue keeps saying what the meeting said
   * while the Task goes on to say whatever the owner makes of it.
   *
   * Promotion is one-way. Nothing here unpromotes, because a decision the
   * owner made is history rather than a toggle.
   */
  recordPromotion(
    actionItemId: string,
    taskId: string,
    versions: { taskVersion: number | null } = { taskVersion: null },
    command: ActionItemCommand = {},
  ): ActionItem {
    return this.transition(
      actionItemId,
      command,
      (current, at, version) => ({
        ...current,
        state: "promoted",
        promotedTaskId: taskId,
        updatedAt: at,
        decidedAt: at,
        decisions: [
          ...current.decisions,
          decision("promote", at, command.actor ?? OWNER, current, version, {
            taskId,
            taskVersion: versions.taskVersion,
            ...(command.missingContentAcknowledged === true
              ? { missingContentAcknowledged: true }
              : {}),
          }),
        ],
      }),
      { alreadyPromoted: true },
    );
  }

  /**
   * The records that recording this promotion would commit, without
   * committing them (#355). The Task acceptance writes them alongside the
   * Task itself, in one publication.
   */
  stagePromotion(
    actionItemId: string,
    taskId: string,
    versions: { taskVersion: number | null },
    command: ActionItemCommand = {},
  ): { committed: ActionItem; all: ActionItem[] | null } {
    return this.stage(
      actionItemId,
      command,
      (current, at, version) => ({
        ...current,
        state: "promoted",
        promotedTaskId: taskId,
        updatedAt: at,
        decidedAt: at,
        decisions: [
          ...current.decisions,
          decision("promote", at, command.actor ?? OWNER, current, version, {
            taskId,
            taskVersion: versions.taskVersion,
            ...(command.missingContentAcknowledged === true
              ? { missingContentAcknowledged: true }
              : {}),
          }),
        ],
      }),
      { alreadyPromoted: true },
    );
  }

  /**
   * Dismiss one pending Action Item (issue #179). Immediate and local-only:
   * no Task is created and no provider is reached — the proposal simply stops
   * being pending. Idempotent, so a double-clicked Dismiss is the same answer
   * rather than a second decision. A promoted Action Item is history and
   * cannot be dismissed.
   */
  dismiss(actionItemId: string, command: ActionItemCommand = {}): ActionItem {
    return this.decide(actionItemId, "dismissed", command, "dismiss");
  }

  /**
   * Return one dismissed Action Item to pending (issue #179). This is both the
   * temporary Undo after a dismissal and the later restore from Debrief
   * history: the record keeps its identity, source, revision and proposal, and
   * only the decision is cleared. The history keeps the dismissal, so a restore
   * is visible as a later decision rather than an erasure. Idempotent while
   * pending; a promoted Action Item cannot be unpromoted.
   */
  restore(actionItemId: string, command: ActionItemCommand = {}): ActionItem {
    return this.decide(actionItemId, "pending", command, "restore");
  }

  /**
   * Select the proposal revision this Action Item should be reviewed and
   * promoted as (#355). A correction raises the latest revision; until the
   * owner selects one, promotion is refused — a reviewed draft never silently
   * picks up content that arrived after the review.
   */
  selectProposal(
    actionItemId: string,
    revision: number,
    command: ActionItemCommand = {},
  ): ActionItem {
    return this.transition(actionItemId, command, (current, at, version) => {
      const chosen = current.proposalRevisions.find((entry) => entry.revision === revision);
      if (!chosen) {
        throw new TaskValidationError(
          "action-item-revision-not-found",
          `That Action Item has no proposal revision ${revision}.`,
        );
      }
      if (current.selectedRevision === revision && current.reviewedThrough >= revision) return null;
      return {
        ...current,
        selectedRevision: revision,
        reviewedThrough: latestProposalRevision(current),
        updatedAt: at,
        decisions: [
          ...current.decisions,
          decision("select-proposal", at, command.actor ?? OWNER, current, version),
        ],
      };
    });
  }

  /**
   * Record a correction to the proposal (#355). The previous revision stays
   * exactly as it was, and the new one is presented as unreviewed: the owner
   * selects it, or keeps the previous content, before anything is promoted.
   */
  correctProposal(
    actionItemId: string,
    content: ActionItemProposal,
    command: ActionItemCommand = {},
  ): ActionItem {
    return this.transition(actionItemId, command, (current, at, version) => {
      const previous = latestProposalRevision(current);
      const revision: ActionItemProposalRevision = {
        revision: previous + 1,
        content,
        origin: { kind: "owner-correction", correctedRevision: previous },
        extractionRevision: current.extractionRevision,
        createdAt: at,
      };
      return {
        ...current,
        proposalRevisions: [...current.proposalRevisions, revision],
        updatedAt: at,
        decisions: [
          ...current.decisions,
          decision("correct-proposal", at, command.actor ?? OWNER, current, version),
        ],
      };
    });
  }

  /**
   * Record what this Action Item's proposal means next to the work already
   * held (#355). The extraction never decides that for the owner: it records
   * the earlier records it considered, and the owner chooses. Choosing
   * `evidence-of-historical` makes this record evidence about the target — it
   * keeps its own identity and history, and is not promotable — and refuses to
   * close a cycle of records pointing at each other.
   */
  reconcile(
    actionItemId: string,
    disposition: ActionItemDisposition,
    options: ActionItemCommand & { targetActionItemId?: string | null } = {},
  ): ActionItem {
    return this.transition(actionItemId, options, (current, at, version) => {
      const target = options.targetActionItemId ?? null;
      const standing = currentReconciliation(current);
      if (standing && sameReconciliation(standing, disposition, target)) return null;
      if (disposition === "evidence-of-historical") {
        if (target === null || target === actionItemId) {
          throw new TaskValidationError(
            "action-item-reconciliation-invalid",
            "Attaching evidence needs a different Action Item to attach it to.",
          );
        }
        const held = this.get(target);
        if (!held) {
          throw new TaskValidationError(
            "action-item-reconciliation-invalid",
            `No Action Item with id ${target}`,
          );
        }
        if (held.reconciledInto !== null) {
          throw new TaskValidationError(
            "action-item-reconciliation-invalid",
            "That Action Item is itself evidence about another one; attaching evidence to it would close a cycle.",
          );
        }
      }
      const reconciliation: ActionItemReconciliation = {
        id: `reconciliation_${randomUUID()}`,
        proposalRevision: current.selectedRevision,
        debriefRunId: current.source.debriefRunId,
        disposition,
        targetActionItemId: disposition === "evidence-of-historical" ? target : null,
        candidateActionItemIds: standing?.candidateActionItemIds ?? [],
        decidedBy: "owner",
        decidedAt: at,
        versions: {
          actionItemVersion: version,
          proposalRevision: current.selectedRevision,
          taskId: current.promotedTaskId,
          taskVersion: null,
        },
      };
      return {
        ...current,
        reconciliations: [...current.reconciliations, reconciliation],
        reconciledInto: reconciliation.targetActionItemId,
        updatedAt: at,
        decisions: [
          ...current.decisions,
          decision(
            /* Attaching evidence is its own decision, not a relabelling: the
               history has to say the owner made this record evidence about
               another one rather than merely recording a relationship. */
            disposition === "evidence-of-historical" ? "attach-evidence" : "reconcile",
            at,
            options.actor ?? OWNER,
            current,
            version,
            { taskId: current.promotedTaskId },
          ),
        ],
      };
    });
  }

  /**
   * Suggest a change to an already promoted Task (#355). Never an edit: the
   * suggestion records the field-level differences and the Task version they
   * were computed against, and applying them is the owner's own Task edit.
   */
  suggestAmendment(
    actionItemId: string,
    suggestion: {
      taskId: string;
      fields: Partial<ActionItemProposal>;
      observedTaskVersion: number;
    },
    command: ActionItemCommand = {},
  ): ActionItem {
    return this.transition(actionItemId, command, (current, at, version) => {
      if (current.promotedTaskId === null || current.promotedTaskId !== suggestion.taskId) {
        throw new TaskValidationError(
          "action-item-amendment-invalid",
          "A Task amendment can only be suggested by the Action Item that created that Task.",
        );
      }
      if (Object.keys(suggestion.fields).length === 0) {
        throw new TaskValidationError(
          "action-item-amendment-invalid",
          "A Task amendment suggestion has to name at least one field.",
        );
      }
      const amendment: ActionItemAmendmentSuggestion = {
        id: `amendment_${randomUUID()}`,
        taskId: suggestion.taskId,
        proposalRevision: current.selectedRevision,
        fields: suggestion.fields,
        observedTaskVersion: suggestion.observedTaskVersion,
        status: "suggested",
        createdAt: at,
        resolvedAt: null,
      };
      return {
        ...current,
        amendments: [...current.amendments, amendment],
        updatedAt: at,
        decisions: [
          ...current.decisions,
          decision("suggest-amendment", at, command.actor ?? OWNER, current, version, {
            taskId: suggestion.taskId,
            taskVersion: suggestion.observedTaskVersion,
          }),
        ],
      };
    });
  }

  /**
   * Record that a suggestion was applied through the owner's Task edit, or
   * declined. The suggestion keeps the versions it was made against either
   * way; only its outcome changes.
   */
  resolveAmendment(
    amendmentId: string,
    status: "applied" | "declined",
    command: ActionItemCommand & { taskVersion?: number | null } = {},
  ): ActionItem {
    const holder = this.store
      .readActionItems()
      .find((item) => item.amendments.some((amendment) => amendment.id === amendmentId));
    if (!holder) {
      throw new TaskValidationError("action-item-not-found", `No Task amendment ${amendmentId}`);
    }
    return this.transition(holder.id, command, (current, at, version) => {
      const amendment = current.amendments.find((entry) => entry.id === amendmentId);
      if (!amendment) {
        throw new TaskValidationError("action-item-not-found", `No Task amendment ${amendmentId}`);
      }
      if (amendment.status === status) return null;
      return {
        ...current,
        amendments: current.amendments.map((entry) =>
          entry.id === amendmentId ? { ...entry, status, resolvedAt: at } : entry,
        ),
        updatedAt: at,
        decisions: [
          ...current.decisions,
          decision(
            status === "applied" ? "apply-amendment" : "decline-amendment",
            at,
            command.actor ?? OWNER,
            current,
            version,
            { taskId: amendment.taskId, taskVersion: command.taskVersion ?? null },
          ),
        ],
      };
    });
  }

  /**
   * Whether this record may become a Task right now, and why not when it may
   * not. The promotion command and the review surface read the same answer.
   */
  promotionRefusal(item: ActionItem): { code: TaskValidationErrorCode; message: string } | null {
    if (item.state === "dismissed") {
      return {
        code: "action-item-dismissed",
        message: "That Action Item was dismissed. Restore it to pending before creating a Task.",
      };
    }
    if (item.reconciledInto !== null) {
      return {
        code: "action-item-not-promotable",
        message:
          "That Action Item records evidence about earlier work. Attach it there instead of creating a Task.",
      };
    }
    if (currentReconciliation(item)?.disposition === "unresolved") {
      return {
        code: "action-item-not-promotable",
        message:
          "That Action Item may repeat work this Workspace already holds. Resolve the relationship before creating a Task.",
      };
    }
    if (item.reviewedThrough < latestProposalRevision(item)) {
      return {
        code: "action-item-not-promotable",
        message:
          "That proposal was corrected after it was reviewed. Select the revision to promote before creating a Task.",
      };
    }
    return null;
  }

  private decide(
    actionItemId: string,
    to: "pending" | "dismissed",
    command: ActionItemCommand,
    kind: ActionItemDecisionKind,
  ): ActionItem {
    return this.transition(
      actionItemId,
      command,
      (current, at, version) => {
        if (current.state === to) return null;
        if (current.state === "promoted") {
          throw new TaskValidationError(
            "action-item-already-promoted",
            to === "dismissed"
              ? "That Action Item was already promoted and cannot be dismissed."
              : "That Action Item was already promoted and cannot be restored to pending.",
          );
        }
        return {
          ...current,
          state: to,
          updatedAt: at,
          decidedAt: to === "dismissed" ? at : null,
          decisions: [
            ...current.decisions,
            decision(kind, at, command.actor ?? OWNER, current, version, {
              taskId: current.promotedTaskId,
            }),
          ],
        };
      },
      { alreadyPromoted: true },
    );
  }

  /**
   * One command's critical section: read the current record, refuse a stale
   * command, apply the change and commit it with the version advanced. A
   * change that would be a no-op returns the record unchanged, which is what
   * makes a repeated command idempotent instead of a second decision.
   */
  private transition(
    actionItemId: string,
    command: ActionItemCommand,
    change: (current: ActionItem, at: string, version: number) => ActionItem | null,
    options: { alreadyPromoted?: boolean } = {},
  ): ActionItem {
    const { committed, all } = this.stage(actionItemId, command, change, options);
    if (all !== null) this.store.writeActionItems(all);
    return committed;
  }

  /**
   * The records a command would commit, without committing them (#355). Task
   * acceptance needs the updated Action Item before the write, so that the
   * Task and the decision that accepted it reach the Workspace together.
   */
  private stage(
    actionItemId: string,
    command: ActionItemCommand,
    change: (current: ActionItem, at: string, version: number) => ActionItem | null,
    options: { alreadyPromoted?: boolean } = {},
  ): { committed: ActionItem; all: ActionItem[] | null } {
    const stored = this.store.readActionItems();
    const current = stored.find((item) => item.id === actionItemId);
    if (!current) {
      throw new TaskValidationError(
        "action-item-not-found",
        `No Action Item with id ${actionItemId}`,
      );
    }
    if (command.expectedVersion !== undefined && command.expectedVersion !== current.version) {
      throw new TaskValidationError(
        "action-item-version-conflict",
        `That Action Item changed since you read it (expected version ${command.expectedVersion}, current ${current.version}). Reload it and review the change.`,
      );
    }
    if (options.alreadyPromoted && current.state === "promoted") {
      throw new TaskValidationError(
        "action-item-already-promoted",
        "That Action Item was already promoted; its decision is history.",
      );
    }
    const at = this.now().toISOString();
    const version = current.version + 1;
    const next = change(current, at, version);
    /* `all: null` is "nothing to write": an idempotent command is the same
       answer, not a second commit that advances the record's version. */
    if (next === null) return { committed: current, all: null };
    const committed: ActionItem = { ...next, version };
    return {
      committed,
      all: stored.map((item) => (item.id === actionItemId ? committed : item)),
    };
  }

  /** One checked output entry: its content and where the extraction saw it. */
  private checkedEntry(
    proposed: MeetingDebriefActionItem,
    occurrence: ActionItemOccurrence,
    candidateAlias: string | null,
  ): CheckedOutputEntry {
    const multipleResponsibility =
      proposed.handoff &&
      (proposed.handoff.responsibility.names.length !== 1 ||
        proposed.handoff.responsibility.basis === "unknown");
    const payload: CheckedEntryPayload = {
      title: proposed.title,
      owner: proposed.owner,
      ownerMentionId: proposed.ownerMentionId,
      ownerProfileId: proposed.ownerProfileId,
      dueDate: proposed.dueDate,
      notes: proposed.handoff ? handoffNotes(proposed.handoff) : "",
      responsiblePerson: multipleResponsibility
        ? null
        : this.proposedResponsiblePerson(proposed.ownerProfileId),
      occurrence,
      handoff: proposed.handoff ?? null,
      /* The structured claim is checked content, like the handoff: two entries
         that agree on every displayed field and disagree on who committed to
         what are two entries, and the promotion gate reads exactly this. */
      responsibilityClaim: proposed.responsibilityClaim ?? null,
    };
    return { candidateAlias, payload };
  }

  /**
   * Where one checked obligation sat in the immutable source. The locator
   * distinguishes repeated identical quotations, which a quotation alone
   * cannot; nothing here is a claim that two quotes mean the same thing.
   */
  private occurrenceOf(proposed: MeetingDebriefActionItem): ActionItemOccurrence {
    const evidence = proposed.handoff?.evidence[0];
    if (!evidence) {
      /* No quotation to locate it by. The position in the checked array is
         deliberately not used: it would make reordering the model's output
         rename the obligation. Two entries left indistinguishable here are
         separated by their ordinal among identical payloads instead. */
      return { locator: "unlocated", timestamp: null, quote: null };
    }
    const identical = (proposed.handoff?.evidence ?? []).filter(
      (candidate) =>
        candidate.quote === evidence.quote && candidate.timestamp === evidence.timestamp,
    );
    const ordinal = identical.indexOf(evidence) + 1;
    return {
      locator: `${evidence.timestamp ?? "no-timestamp"}#${ordinal}`,
      timestamp: evidence.timestamp,
      quote: evidence.quote,
    };
  }

  private newActionItem(input: {
    id: string;
    input: ActionItemMaterialization;
    entry: CheckedOutputEntry;
    entryId: string;
    key: string;
    revision: number;
    at: string;
    candidates: string[];
    /** One target per dependency of the checked handoff, in its own order. */
    targets: HandoffDependencyTarget[];
  }): ActionItem {
    const { payload } = input.entry;
    const origin: ActionItemProposalRevision["origin"] = {
      kind: "extraction",
      debriefRunId: input.input.debriefRunId,
      transcriptId: input.input.transcriptId,
      meetingId: input.input.meetingId,
      materializationKey: input.key,
      outputEntryId: input.entryId,
      payloadChecksum: payloadChecksum(payload),
      candidateAlias: input.entry.candidateAlias,
    };
    const candidateAliases =
      input.entry.candidateAlias === null ? [] : [input.entry.candidateAlias];
    return {
      /* The checked handoff travels with the record: the review surface reads
         its execution detail, and automatic promotion reads its commitment and
         responsibility basis to decline what only the owner can judge. Its
         dependencies carry the targets resolved against the checked output;
         the artifact the model produced keeps the claims without them. */
      /* The claim travels with the record for the same reason: it is what the
         promotion gate reads to tell a supported commitment from a
         relationship only the owner can judge. */
      ...(payload.responsibilityClaim ? { responsibilityClaim: payload.responsibilityClaim } : {}),
      ...(payload.handoff
        ? { handoff: withDependencyTargets(payload.handoff, input.targets) }
        : {}),
      id: input.id,
      source: {
        debriefRunId: input.input.debriefRunId,
        transcriptId: input.input.transcriptId,
        meetingId: input.input.meetingId,
        ...(input.input.reviewOnly === true ? { reviewOnly: true } : {}),
        ...(input.input.contextChecksum ? { contextChecksum: input.input.contextChecksum } : {}),
        ...(input.input.firstExtraction
          ? {
              promotion: {
                claim: input.input.firstExtraction.claim,
                basis: input.input.firstExtraction.basis,
                operationId: input.input.firstExtraction.operationId,
                reservedAt: input.input.firstExtraction.reservedAt,
                authorization: input.input.firstExtraction.authorization,
              },
            }
          : {}),
      },
      extractionRevision: input.revision,
      evidence: {
        responsibleMentionId: payload.ownerMentionId,
        responsibleSurfaceName: payload.owner,
      },
      proposalRevisions: [
        {
          revision: 1,
          content: {
            title: payload.title,
            notes: payload.notes,
            dueDate: payload.dueDate,
            responsiblePerson: payload.responsiblePerson,
          },
          origin,
          extractionRevision: input.revision,
          createdAt: input.at,
        },
      ],
      selectedRevision: 1,
      reviewedThrough: 1,
      observations: [
        {
          id: `observation_${randomUUID()}`,
          proposalRevision: 1,
          transcriptId: input.input.transcriptId,
          transcriptObservedRevision: input.input.transcriptObservedRevision ?? null,
          transcriptChecksum: input.input.transcriptChecksum ?? null,
          occurrence: payload.occurrence,
          artifactId: input.input.debriefRunId,
          outputEntryId: input.entryId,
          candidateAliases,
          notedAt: input.at,
        },
      ],
      decisions: [],
      reconciliations:
        input.candidates.length === 0
          ? []
          : [
              {
                id: `reconciliation_${randomUUID()}`,
                proposalRevision: 1,
                debriefRunId: input.input.debriefRunId,
                disposition: "unresolved",
                targetActionItemId: null,
                candidateActionItemIds: input.candidates,
                decidedBy: "extraction",
                decidedAt: input.at,
                versions: {
                  actionItemVersion: 1,
                  proposalRevision: 1,
                  taskId: null,
                  taskVersion: null,
                },
              },
            ],
      reconciledInto: null,
      amendments: [],
      version: 1,
      state: "pending",
      promotedTaskId: null,
      createdAt: input.at,
      updatedAt: input.at,
      decidedAt: null,
    };
  }

  /**
   * The earlier Action Items this checked entry may be about: same Transcript,
   * same normalized title. A candidate is a question for the owner, never a
   * merge — no fuzzy score, no shared meeting and no model confidence decides
   * that two records are one obligation.
   */
  private reconciliationCandidates(
    stored: ActionItem[],
    input: ActionItemMaterialization,
    payload: CheckedEntryPayload,
  ): string[] {
    const title = normalize(payload.title);
    return stored
      .filter(
        (item) =>
          item.source.transcriptId === input.transcriptId &&
          item.source.debriefRunId !== input.debriefRunId &&
          normalize(actionItemProposal(item).title) === title,
      )
      .map((item) => item.id);
  }

  private proposedResponsiblePerson(profileId: string | null): TaskResponsiblePerson | null {
    if (profileId === null) return null;
    return profileId === this.ownerProfileId()
      ? { kind: "owner" }
      : { kind: "person-profile", profileId };
  }
}

/** The one local user this Workspace has; recorded with every decision. */
const OWNER = "owner";

function decision(
  kind: ActionItemDecisionKind,
  at: string,
  actor: string,
  current: ActionItem,
  version: number,
  task: {
    taskId?: string | null;
    taskVersion?: number | null;
    missingContentAcknowledged?: boolean;
  } = {},
): ActionItemDecisionRecord {
  const versions: ActionItemVersions = {
    actionItemVersion: version,
    proposalRevision: current.selectedRevision,
    taskId: task.taskId ?? null,
    taskVersion: task.taskVersion ?? null,
  };
  return {
    at,
    actor,
    kind,
    proposalRevision: current.selectedRevision,
    versions,
    ...(task.missingContentAcknowledged === true ? { missingContentAcknowledged: true } : {}),
  };
}

function sameReconciliation(
  current: ActionItemReconciliation,
  disposition: ActionItemDisposition,
  target: string | null,
): boolean {
  if (current.disposition !== disposition) return false;
  return disposition === "evidence-of-historical" ? current.targetActionItemId === target : true;
}

/** An opaque Workspace identity. Allocated once; nothing derives it. */
function allocateActionItemId(): string {
  return `ai_${randomUUID().replaceAll("-", "")}`;
}

/**
 * The handoff a record stores: the checked claims plus the targets resolved
 * against the checked output. A handoff written before targets existed keeps
 * its own shape untouched, because its dependency names were never resolved
 * and today's titles are not the evidence that they meant the same work.
 */
function withDependencyTargets(
  handoff: MeetingHandoffRecord,
  targets: HandoffDependencyTarget[],
): MeetingHandoffRecord {
  if (handoff.version === 1) return handoff;
  return {
    ...handoff,
    dependencies: handoff.dependencies.map((dependency, index) => ({
      ...dependency,
      ...(targets[index] ? { target: targets[index] } : {}),
    })),
  };
}

/**
 * What one recorded reference resolves to now. A reference that named a record
 * the Workspace later reconciled into another one follows that redirect and
 * keeps the identity it originally named; a chain that points back at itself
 * resolves to nothing rather than looping.
 */
function followRedirect(
  items: readonly ActionItem[],
  actionItemId: string,
): { actionItemId: string; redirectedFrom: string | null } | "missing-record" | "redirect-cycle" {
  const visited = new Set<string>();
  let current = actionItemId;
  for (;;) {
    if (visited.has(current)) return "redirect-cycle";
    visited.add(current);
    const held = items.find((item) => item.id === current);
    if (!held) return "missing-record";
    if (held.reconciledInto === null) {
      return {
        actionItemId: current,
        redirectedFrom: current === actionItemId ? null : actionItemId,
      };
    }
    current = held.reconciledInto;
  }
}

/**
 * Every Action Item's dependencies resolved against the records held now
 * (#347, MWR-048). The reference is proposal/evidence lineage — it names what
 * the work depends on and never schedules it (ADR-0054): nothing here is a
 * Task field, and no Task is created to stand in for an external target.
 */
function actionItemDependencyReferences(
  items: readonly ActionItem[],
): Map<string, ResolvedActionItemDependency[]> {
  const byKey = materializationIndex(items);
  const references = new Map<string, ResolvedActionItemDependency[]>();
  for (const item of items) {
    if (!item.handoff) continue;
    const dependencies = handoffDependencies(item.handoff);
    if (dependencies.length === 0) continue;
    references.set(
      item.id,
      dependencies.map((dependency) => {
        const base = {
          wording: dependency.wording,
          condition: dependency.condition,
          provenance: dependency.provenance,
        };
        if (dependency.target.kind === "external") {
          return { ...base, target: { kind: "external" } as const };
        }
        if (dependency.target.kind === "unresolved") {
          return {
            ...base,
            target: { kind: "unresolved", reason: dependency.target.reason },
          };
        }
        const mapping = byKey.get(
          materializationKey(item.source.debriefRunId, dependency.target.outputEntryId),
        );
        if (!mapping) {
          return {
            ...base,
            target: {
              kind: "unresolved",
              reason: "missing-record" satisfies HandoffDependencyUnresolved,
            },
          };
        }
        const followed = followRedirect(items, mapping.actionItemId);
        if (typeof followed === "string") {
          return {
            ...base,
            target: { kind: "unresolved", reason: followed satisfies HandoffDependencyUnresolved },
          };
        }
        return {
          ...base,
          target: {
            kind: "action-item",
            actionItemId: followed.actionItemId,
            proposalRevision: mapping.proposalRevision,
            redirectedFrom: followed.redirectedFrom,
          },
        };
      }),
    );
  }
  return references;
}

/** An unset filter matches everything; a set one has to be equal. */
function matches<T>(expected: T | undefined, actual: T): boolean {
  return expected === undefined || expected === actual;
}

/**
 * The revision this materialization writes. A Run with nothing held is on its
 * first extraction; otherwise an entry nobody has materialized means a new
 * revision, and a re-run of the same checked output means the one already
 * recorded.
 */
function nextRevision(
  held: ActionItem[],
  entries: CheckedOutputEntry[],
  input: ActionItemMaterialization,
  byKey: Map<string, ActionItemMaterializationMapping>,
): number {
  if (held.length === 0) return 1;
  const highest = held.reduce((max, item) => Math.max(max, item.extractionRevision), 1);
  const unseen = entries.some(
    (_, index) => !byKey.has(materializationKey(input.debriefRunId, outputEntryId(entries, index))),
  );
  return unseen ? highest + 1 : highest;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}
