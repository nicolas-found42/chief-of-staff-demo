import type {
  DebriefSectionAvailability,
  DebriefSectionName,
  MeetingDebriefExtraction,
  MeetingDebriefRunResult,
  MeetingDebriefReviewState,
  ExtractionContextSnapshot,
  ActionItemMaterializationMapping,
  AutomaticPromotionAuthorizationFacts,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import {
  DEBRIEF_SECTIONS,
  debriefSectionResolved,
  validatedDebriefSections,
} from "@chief-of-staff-demo/shared";
import {
  MEETING_DEBRIEF_MODULE_ID,
  MEETING_DEBRIEF_MODULE_VERSION,
} from "@chief-of-staff-demo/shared";
import type { CompleteJson } from "../../llm/providers.js";
import { modelDiagnosticEventDetail } from "../../llm/failure.js";
import { errorMessage } from "../../engine/failure.js";
import type { RunOutcome } from "../../runs.js";
import type { RunContext, ShellModule } from "../../engine/module.js";
import type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReview,
  DebriefIdentityReviewReader,
  DebriefOutputsDeps,
} from "./deps.js";
import {
  approvalBlockers,
  initialReviewState,
  mergeRegeneratedField,
  parseReviewState,
  serializeReviewState,
  type DebriefApprovalGateDeps,
} from "./review.js";
import { resolveActionItemOwners, stripUnverifiedRecipientEmails } from "./extraction.js";
import { emailOptions, emailPreview, type DebriefActionItemReader } from "./email.js";
import {
  extractDebriefCore,
  extractDebriefSections,
  type CandidateExtractionOptions,
  type DebriefCheckedCorePayload,
} from "./candidate-extraction.js";
import { composeExternalDebriefBody } from "./externalBody.js";
import {
  DebriefIntegrityError,
  DebriefUnavailableError,
  debriefChecksum,
  debriefTextChecksum,
  nextRevisionTarget,
  readOperation,
  readPublishedDebrief,
  reconcileDebrief,
  resumableCheckedCore,
  writeCheckedCore,
  type DebriefArtifactIO,
  type DebriefFirstExtractionReservation,
  type DebriefPolicySnapshot,
  type DebriefProducedRevision,
  type DebriefReconcileOutcome,
  type DebriefStoredCore,
} from "./publication.js";

export type {
  DebriefCatalogReader,
  DebriefExtractInput,
  DebriefIdentityReviewReader,
} from "./deps.js";

/**
 * The Module's input. `fresh` comes from the Catalog's mining hand-off,
 * `resume` from a Stage retry, and `review` from an owner re-entering a Run
 * that has already finished — to regenerate a field, or to publish the gated
 * outward writes. There is no clock arm: nothing expires, because nothing
 * waits.
 */
export type DebriefInput =
  | { kind: "fresh"; transcriptId: string }
  | { kind: "resume"; fromStage: "associate" | "extract" }
  | { kind: "review"; action: "owner" }
  /**
   * Continue a Run whose preparation is already durable, without ever asking
   * the model: the recovery sweep's entry point (#358).
   */
  | { kind: "reconcile" };

export interface MeetingDebriefModuleDeps {
  now?: () => Date;
  readActionItems?: DebriefActionItemReader;
  catalog: DebriefCatalogReader;
  identity: DebriefIdentityReviewReader;
  /** Deterministic extraction seam (tests, hermetic runtimes). */
  extract?: (input: DebriefExtractInput) => Promise<MeetingDebriefExtraction>;
  /**
   * The section outcomes a deterministic harness declares instead of
   * producing them (#345). Absent — as for every harness that predates the
   * phase split — the injected extraction is a complete revision whose
   * sections all validated.
   */
  sections?: (input: { transcriptId: string }) => readonly DebriefSectionAvailability[] | undefined;
  /** Model-backed extraction when no override is injected. */
  getCompleteJson?: () => CompleteJson;
  /** Provider/model recorded on extract_attempt events for diagnosis. */
  getLlmInfo?: () => { provider: string; model: string };
  /**
   * The approval gate's collaborators (spec #450). Absent — as in a minimal
   * extraction-only harness — the gate stays closed: without a confirmed
   * owner identity and a Profile directory, no Debrief can be approved.
   */
  gate?: DebriefApprovalGateDeps;
  /**
   * The outward-write surface (issue #141). Absent, approval writes nothing
   * outward — the Module has no other way to reach Gmail or Tasks.
   */
  outputs?: DebriefOutputsDeps;
  /**
   * Where a successful extraction's proposed commitments become durable
   * Action Items (issue #177). The Debrief produces them and owns none of
   * them: this is a hand-over to the Workspace, and it is part of the
   * publication's coordinated materialization (#358), so it answers with the
   * exact mappings each checked entry materialized under — the manifest
   * records them, and a mismatch is what stops completion.
   * Absent — as in an extraction-only harness — nothing is materialized and
   * the Run still finishes, with that surface declared rather than implied.
   */
  materializeActionItems?: DebriefMaterializer;
  /**
   * The lineage reservation for this Run, read before the model is asked
   * anything (#358, ADR-0084). Absent means no resolver is wired: the claim is
   * `unknown`, which never authorizes automatic acceptance.
   */
  firstExtraction?: (input: {
    transcriptId: string;
    runId: string;
  }) => DebriefFirstExtractionReservation;
  /** The policy facts captured with the reservation. */
  policy?: () => DebriefPolicySnapshot;
}

/** One coordinated materialization: the mappings the checked entries now hold. */
type DebriefMaterializer = (
  input: DebriefActionItemHandover,
) => readonly ActionItemMaterializationMapping[] | void;

/** What the Debrief hands the Workspace after one successful extraction. */
interface DebriefActionItemHandover {
  debriefRunId: string;
  transcriptId: string;
  /** The Meeting the Transcript belongs to; null until one is placed. */
  meetingId: string | null;
  /** The immutable source revision the extraction read, when it is known. */
  transcriptObservedRevision?: number | null;
  transcriptChecksum?: string | null;
  /** The frozen context checksum this revision was checked under (#360). */
  contextChecksum?: string;
  actionItems: MeetingDebriefExtraction["actionItems"];
  /** The extraction's own candidate ids, aligned with `actionItems`. */
  candidateAliases?: (string | null)[];
  /**
   * The lineage reservation recorded before inference, passed through so the
   * Tasks side decides eligibility on what was reserved rather than on what
   * the queue happens to hold now (#358). It carries the automatic-promotion
   * authorization facts too (#360): the release restriction and the owner's
   * explicit enablement as they stood before the model was asked anything, so
   * a later release never reopens this operation and a later enablement never
   * sweeps it up.
   */
  firstExtraction?: {
    operationId: string;
    claim: "first" | "review-only" | "unknown";
    basis: string;
    reservedAt: string;
    authorization: AutomaticPromotionAuthorizationFacts | null;
  };
}

/**
 * The one outward write the Debrief performs (issues #141, #182). Recipients
 * are every confirmed attendee other than the owner, plus the recipients the
 * owner confirmed explicitly. With no outward surface wired the action still
 * completes and nothing leaves the app, which is how #139's "no outward write"
 * property survives as structure rather than as a promise.
 */
/** The Gmail draft receipt, read on every retry so a repeat drafts nothing twice. */
interface DebriefDraftReceipt {
  version: 1;
  draftId: string;
  createdAt?: string;
  to: string[];
}

function readReceipt<T>(ctx: RunContext, file: string): T | null {
  const raw = ctx.readFile(file);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Create the Gmail draft, and nothing else (issue #182). This used to create
 * Google Tasks too, which made one button mean two unrelated things: a
 * recipient problem could block accepted work, and an owner who wanted the
 * work without the email had no way to say so. Tasks now come from the Action
 * Item queue, which needs no Gmail at all.
 *
 * The draft is driven from its Run receipt rather than from whether this
 * function has run before, so a retry after a failure drafts nothing twice.
 */
async function writeApprovalOutputs(
  ctx: RunContext,
  deps: MeetingDebriefModuleDeps,
  record: TranscriptRecord,
  state: MeetingDebriefReviewState,
  ownerEmail: string | null,
): Promise<void> {
  const outputs = deps.outputs;
  if (outputs === undefined) return;

  const debrief = currentDebrief(ctx);
  let draft = readReceipt<DebriefDraftReceipt>(ctx, "draft.json");
  if (draft === null) {
    const to = state.email?.to ?? [
      ...state.roster.entries
        .filter((entry) => entry.email !== ownerEmail)
        .map((entry) => entry.email),
      ...state.recipients.additional.map((recipient) => recipient.email),
    ];
    const draftId = await outputs.createDraft({
      to: state.email?.to ?? to,
      subject: state.email?.subject ?? `Meeting debrief — ${record.source.fileName}`,
      body:
        state.email?.body ?? composeExternalDebriefBody(debrief, state.review.droppedActionItems),
    });
    draft = { version: 1, draftId, to, createdAt: (deps.now?.() ?? new Date()).toISOString() };
    ctx.writeFile("draft.json", `${JSON.stringify(draft, null, 2)}\n`);
    ctx.event("debrief_draft_created", { draftId, recipientCount: to.length });
  }
}

/**
 * What a production closure hands the reconciler: the revision bytes, plus
 * the extraction they encode, so a regeneration can merge one field without
 * re-reading its own serialized output.
 */
interface DebriefProducedExtraction extends DebriefProducedRevision {
  extraction: MeetingDebriefExtraction;
}

/** The sections one outcome left unavailable, in the contract's own order. */
function unavailableSections(outcome: DebriefReconcileOutcome): DebriefSectionName[] {
  return outcome.availability.sections
    .filter((section) => !debriefSectionResolved(section.state))
    .map((section) => section.name);
}

/**
 * Blank the sections a revision could not validate (#345). The stored result
 * keeps the extraction's shape — the model-result contract is not this
 * module's to widen — so a failed section is emptied here *and* named
 * unavailable in the revision's availability. Nothing may read the empty
 * value without reading the availability beside it.
 */
function applySectionOutcomes(
  extraction: MeetingDebriefExtraction,
  sections: readonly DebriefSectionAvailability[],
): MeetingDebriefExtraction {
  const resolved = (name: DebriefSectionName): boolean => {
    const state = sections.find((section) => section.name === name)?.state ?? "validated";
    return debriefSectionResolved(state);
  };
  return {
    ...extraction,
    summary: resolved("summary") ? extraction.summary : "",
    decisions: resolved("decisions") ? extraction.decisions : [],
    openQuestions: resolved("openQuestions") ? extraction.openQuestions : [],
    effectivenessEvidence: resolved("effectivenessEvidence")
      ? extraction.effectivenessEvidence
      : "",
    coachingAdvice: resolved("coachingAdvice") ? extraction.coachingAdvice : "",
    suggestedRecipients: resolved("suggestedRecipients") ? extraction.suggestedRecipients : [],
  };
}

/**
 * The availability a new revision reports: every section keeps the state the
 * previously published revision established for it, except the one this
 * regeneration asked for, which takes its own new outcome (#345, MWR-042).
 */
function mergeSectionAvailability(
  previous: readonly DebriefSectionAvailability[] | null,
  produced: readonly DebriefSectionAvailability[],
  regenerated: DebriefSectionName | null,
): DebriefSectionAvailability[] {
  return DEBRIEF_SECTIONS.map((name) => {
    const fresh = produced.find((section) => section.name === name);
    if (regenerated === null || name === regenerated) {
      return fresh ? { ...fresh } : { name, state: "absent", reason: null };
    }
    const held = previous?.find((section) => section.name === name);
    return held ? { ...held } : fresh ? { ...fresh } : { name, state: "absent", reason: null };
  });
}

/** How the Run's association stands, read from the immutable record itself. */
function rosterStatusOf(record: TranscriptRecord): "prefilled" | "requires_confirmation" {
  return record.occurrence !== null && record.roster.length > 0
    ? "prefilled"
    : "requires_confirmation";
}

/**
 * Everything one model-backed phase needs. The provider, the checkpoint scope
 * and the capture surface are per-Run facts; the phase split (#345) means the
 * core phase and a later section-only retry build this the same way.
 */
function modelExtractionOptions(
  ctx: RunContext,
  record: TranscriptRecord,
  identity: DebriefIdentityReview,
  deps: MeetingDebriefModuleDeps,
  useCheckpoints: boolean,
  contextChecksum: string,
): CandidateExtractionOptions {
  if (!deps.getCompleteJson) {
    throw new Error("Meeting Debrief extraction provider is unavailable");
  }
  const attempt = ctx.attempt();
  const llm = deps.getLlmInfo?.() ?? { provider: "unknown", model: "unknown" };
  return {
    record,
    identity,
    contextChecksum,
    complete: deps.getCompleteJson(),
    operationId: ctx.runId,
    runId: ctx.runId,
    ...(useCheckpoints
      ? {
          checkpoint: {
            scope: JSON.stringify(llm),
            read: (key: string): unknown => {
              const saved = ctx.readFile(`debrief-checkpoint-${key}.json`);
              if (saved === null) return undefined;
              try {
                return JSON.parse(saved) as unknown;
              } catch {
                return undefined;
              }
            },
            write: (key: string, value: unknown) =>
              ctx.writeFile(`debrief-checkpoint-${key}.json`, JSON.stringify(value)),
          },
        }
      : {}),
    progress: (event) => ctx.event("debrief_extraction_progress", event),
    retry: { onAttempt: (event) => ctx.event("model_attempt", { ...event }) },
    capture: (name, value) =>
      ctx.writeFile(`candidate-${attempt}-${name}.json`, JSON.stringify(value, null, 2)),
  };
}

/** The currently published Debrief, resolved through its publication pointer. */
function currentDebrief(ctx: RunContext): MeetingDebriefExtraction {
  const published = readPublishedDebrief({ read: (name) => ctx.readFile(name) });
  if (!published) throw new Error("Debrief Run has no published revision to read");
  return published.result.debrief;
}

/**
 * Meeting Debrief v2 — extract, then wait for the owner (issues #139/#140).
 * The review wait is a Shell-owned durable wait (ADR-0038): it resumes when
 * the owner approves or regenerates, and expires to `skipped` after thirty
 * days. Regeneration is a Stage of its own whose model call sees only the
 * immutable input — the rejected value is structurally unreachable
 * (ADR-0037). The Module receives no outward-write capability at all, so a
 * Debrief Run structurally cannot write one.
 */
export function meetingDebriefModule(deps: MeetingDebriefModuleDeps): ShellModule<DebriefInput> {
  const now = deps.now ?? (() => new Date());
  /* A harness without a gate stays closed: no confirmed owner identity and no
     Profile directory can only ever mean "blocked", never "approved". */
  const gate: DebriefApprovalGateDeps = deps.gate ?? {
    ownerEmail: () => null,
    verifiedForEmail: () => null,
  };

  /** The immutable context this Run extracts from (#342, #356, MWR-043). */
  const captureContext = (record: TranscriptRecord): ExtractionContextSnapshot => {
    const identity = deps.identity.reviewFor(record.id);
    return {
      version: 1,
      capturedAt: now().toISOString(),
      source: {
        transcriptId: record.id,
        sourceSystem: record.source.sourceSystem,
        externalFileId: record.source.externalFileId,
        fileName: record.source.fileName,
        checksum: record.source.checksum,
        observedRevision: record.source.observedRevision,
        extractorVersion: record.extractorVersion,
      },
      association: record.association,
      meetingId: record.meetingId,
      occurrence: record.occurrence,
      timeAnchor: record.timeAnchor ?? null,
      roster: record.roster,
      speakers: record.speakers,
      speakerIdentityMappings: record.speakerIdentityMappings,
      identityReview: {
        mentionCount: identity.mentions.length,
        decisionCount: identity.decisions.length,
        organizationCount: identity.organizations.length,
      },
    };
  };

  /**
   * The checked result as one revision is addressed by: serialized bytes, not
   * a file. A revision whose sections did not all validate carries that fact
   * with its bytes (#345): an interrupted manifest write is later adopted
   * without asking the model again, and the adopted revision must still read
   * as the incomplete revision it is.
   */
  const resultText = (
    debrief: MeetingDebriefExtraction,
    transcriptId: string,
    sections?: readonly DebriefSectionAvailability[],
  ): string =>
    `${JSON.stringify(
      {
        version: 1,
        transcriptId,
        extractedAt: now().toISOString(),
        debrief,
        ...(sections?.some((section) => !debriefSectionResolved(section.state))
          ? { sections: sections.map((section) => ({ ...section })) }
          : {}),
      } satisfies MeetingDebriefRunResult,
      null,
      2,
    )}\n`;

  /** The frozen context's checksum, or undefined while none has been captured. */
  const contextChecksum = (ctx: RunContext): string | undefined => {
    const frozen = ctx.readFile("context-snapshot.json");
    return frozen === null ? undefined : debriefChecksum(frozen);
  };

  /** The Run directory as the publication machinery reads and writes it. */
  const ioFor = (ctx: RunContext): DebriefArtifactIO => ({
    read: (name) => ctx.readFile(name),
    write: (name, text) => ctx.writeFile(name, text),
  });

  /** The reservation this Run records before the model is asked anything. */
  const reserve = (ctx: RunContext, record: TranscriptRecord): DebriefFirstExtractionReservation =>
    deps.firstExtraction?.({ transcriptId: record.id, runId: ctx.runId }) ?? {
      claim: "unknown",
      basis: "no-lineage-resolver-wired",
      reservedAt: now().toISOString(),
      lineageRunId: null,
      authorization: null,
    };

  const policySnapshot = (): DebriefPolicySnapshot =>
    deps.policy?.() ?? {
      capturedAt: now().toISOString(),
      actionItemPolicy: null,
      authorization: null,
    };

  const ensureReviewState = (
    ctx: RunContext,
    record: TranscriptRecord,
  ): MeetingDebriefReviewState => {
    const raw = ctx.readFile("review.json");
    const existing = parseReviewState(raw);
    if (existing) return existing;
    /* A review record that is present and unreadable is owner evidence that
       cannot be read, not an absent one: creating it again would replace
       recipients, selections and locked email previews with the defaults a
       fresh Run starts from, so recovery refuses instead (#344 §4). */
    if (raw !== null) {
      throw new DebriefIntegrityError(
        "unreadable-review",
        "review.json exists and is not a Debrief review record",
      );
    }
    const state = initialReviewState(ctx.runId, record);
    ctx.writeFile("review.json", serializeReviewState(state));
    return state;
  };

  /**
   * The deterministic seam's revision: the extraction a harness injected,
   * with the section outcomes it declared. Absent outcomes mean a complete
   * revision, which is what every harness that predates #345 means.
   */
  const injectedRevision = async (record: TranscriptRecord): Promise<DebriefProducedExtraction> => {
    if (!deps.extract) {
      throw new Error("Meeting Debrief extraction provider is unavailable");
    }
    const identity = deps.identity.reviewFor(record.id);
    const extracted = await deps.extract({ record, identity });
    const sections = deps.sections?.({ transcriptId: record.id }) ?? validatedDebriefSections();
    const resolved = resolveActionItemOwners(applySectionOutcomes(extracted, sections), identity);
    const debrief = stripUnverifiedRecipientEmails(resolved, record);
    return {
      extraction: debrief,
      text: resultText(debrief, record.id, sections),
      aliases: [],
      sections: sections.map((section) => ({ ...section })),
    };
  };

  /**
   * The model-backed revision, in the two phases #345 requires: the checked
   * core is committed the moment it exists, and the sections are asked for
   * only after that. `reuseCore` is what makes a retry a retry — the stored
   * core is resumed and no discovery, accounting or enrichment call is made.
   */
  const produceModelRevision = async (
    ctx: RunContext,
    record: TranscriptRecord,
    options: { useCheckpoints: boolean; reuseCore: boolean },
  ): Promise<DebriefProducedExtraction> => {
    const attempt = ctx.attempt();
    const llm = deps.getLlmInfo?.() ?? { provider: "unknown", model: "unknown" };
    const stream = ioFor(ctx);
    const contextText = ctx.readFile("context-snapshot.json");
    if (contextText === null) {
      throw new DebriefIntegrityError(
        "missing-context",
        "the frozen context must exist before the core is checked",
      );
    }
    const match = {
      sourceChecksum: debriefTextChecksum(record.normalizedText),
      contextChecksum: debriefChecksum(contextText),
    };
    try {
      ctx.event("extract_attempt", { attempt, provider: llm.provider, model: llm.model });
      const identity = deps.identity.reviewFor(record.id);
      const extractionOptions = modelExtractionOptions(
        ctx,
        record,
        identity,
        deps,
        options.useCheckpoints,
        match.contextChecksum,
      );
      let core: DebriefStoredCore<DebriefCheckedCorePayload> | null = options.reuseCore
        ? resumableCheckedCore<DebriefCheckedCorePayload>(stream, ctx.artifactNames(), match)
        : null;
      if (core) {
        ctx.event("debrief_core_reused", {
          revisionId: core.record.revisionId,
          candidates: core.record.payload.candidates.length,
          outputs: core.record.payload.actions.length,
        });
      } else {
        const payload = await extractDebriefCore(extractionOptions);
        const operation = readOperation(stream);
        if (!operation) {
          throw new DebriefIntegrityError(
            "missing-operation",
            "the checked core needs the operation it was reserved under",
          );
        }
        core = writeCheckedCore(stream, {
          revision: nextRevisionTarget(stream),
          operation,
          preparedAt: now().toISOString(),
          sourceChecksum: match.sourceChecksum,
          contextChecksum: match.contextChecksum,
          payload,
        });
        ctx.event("debrief_core_prepared", {
          revisionId: core.record.revisionId,
          candidates: payload.candidates.length,
          outputs: payload.actions.length,
        });
      }
      const { extraction, sections } = await extractDebriefSections(
        core.record.payload,
        extractionOptions,
      );
      const resolved = resolveActionItemOwners(extraction, identity);
      const debrief = stripUnverifiedRecipientEmails(resolved, record);
      ctx.event("extract_ok", {
        attempt,
        actionItems: debrief.actionItems.length,
        decisions: debrief.decisions.length,
        openQuestions: debrief.openQuestions.length,
      });
      return {
        extraction: debrief,
        text: resultText(debrief, record.id, sections),
        aliases: core.record.payload.retainedIds,
        sections,
        core: { artifact: core.artifact, checksum: core.checksum },
      };
    } catch (error) {
      ctx.event("extract_error", {
        attempt,
        error: errorMessage(error),
        ...modelDiagnosticEventDetail(error),
      });
      throw error;
    }
  };

  /**
   * The one reconciler, entered by every path that finalizes a Debrief (#358,
   * ADR-0084). `produce` runs the model; when it is absent nothing may start
   * inference, so a Run with no intact prepared revision fails visibly rather
   * than inventing one.
   *
   * The outcome is returned whole rather than unwrapped, because an
   * incomplete revision is a real publication whose Run must not report done
   * (#345, ADR-0085): the caller decides what a person is told.
   */
  const reconcile = async (
    ctx: RunContext,
    record: TranscriptRecord,
    produce?: () => Promise<DebriefProducedRevision>,
    intent: "publish" | "regenerate" = "publish",
  ): Promise<DebriefReconcileOutcome> => {
    const stream = ioFor(ctx);
    const reservation = reserve(ctx, record);
    const policy = policySnapshot();
    /* The candidate accounting of the revision being materialized: produced
       bytes carry their own, and an adopted revision carries the core's. */
    let aliases: string[] = [];
    const outcome = await reconcileDebrief({
      io: stream,
      names: () => ctx.artifactNames(),
      runId: ctx.runId,
      record,
      context: captureContext(record),
      firstExtraction: reservation,
      policy,
      intent,
      now,
      produce: async () => {
        if (!produce) {
          throw new DebriefUnavailableError(
            `Run ${ctx.runId} has no prepared revision and this path may not start inference`,
          );
        }
        const revision = await produce();
        aliases = [...(revision.aliases ?? [])].filter((alias): alias is string => alias !== null);
        return revision;
      },
      materialize: (result, revision) =>
        deps.materializeActionItems?.({
          debriefRunId: ctx.runId,
          transcriptId: record.id,
          meetingId: record.meetingId,
          transcriptObservedRevision: record.source.observedRevision,
          transcriptChecksum: record.source.checksum,
          /* The frozen context the checked revision stands on: read from the
             Run's own artifact, so the claim binds what the publication bound
             rather than a context re-captured later. */
          ...(contextChecksum(ctx) ? { contextChecksum: contextChecksum(ctx)! } : {}),
          actionItems: result.debrief.actionItems,
          candidateAliases: aliases,
          ...(revision.reviewOnly ? { reviewOnly: true } : {}),
          ...(deps.firstExtraction
            ? {
                firstExtraction: {
                  operationId: `op-${ctx.runId}`,
                  claim: reservation.claim,
                  basis: reservation.basis,
                  reservedAt: reservation.reservedAt,
                  authorization: reservation.authorization,
                },
              }
            : {}),
        }),
      hasMaterializationSurface: deps.materializeActionItems !== undefined,
      ensureReview: () => {
        ensureReviewState(ctx, record);
      },
      event: (type, detail) => ctx.event(type, detail),
    });
    ctx.event("debrief_reconciled", {
      reconciled: outcome.reconciled,
      modelCalls: outcome.modelCalls,
      completed: outcome.completed,
      revisionId: outcome.publication.revisionId,
      generation: outcome.publication.generation,
    });
    return outcome;
  };

  /**
   * One owner Turn on a Run that has already finished. The Debrief no longer
   * waits for anybody, so this is only ever entered deliberately: the owner
   * asked to regenerate a field, or to publish the gated outward writes. Both
   * end the Run again rather than returning it to a wait.
   */
  const reviewTurn = async (ctx: RunContext, action: "owner"): Promise<RunOutcome> => {
    void action;
    const transcriptId = ctx.meta().externalId ?? null;
    if (!transcriptId) {
      throw new Error("Debrief Run has no transcript identity");
    }
    const record = deps.catalog.getTranscript(transcriptId);
    /* The Catalog lost the record: the Debrief's source is gone, so the Run
       ends skipped the same way an associate-stage loss does. */
    if (!record) {
      return { status: "skipped", reason: "transcript_not_in_catalog" };
    }
    const state = await ctx.stage("review", async () => ensureReviewState(ctx, record));

    const request = state.request;

    if (request?.kind === "regenerate") {
      // ADR-0037: the regeneration is one audited Stage, and its model call
      // sees exactly what every other generation saw — the immutable record
      // and the Catalog's review state. The replaced value is not an input.
      const merged = await ctx.stage("regenerate", async () => {
        /* A regeneration is a new revision of this operation (#358): the
           reconciler prepares and publishes it as its own immutable bytes,
           and a replacement that fails leaves the previous publication —
           revision, mappings and review — exactly where it was. */
        const held = readPublishedDebrief(ioFor(ctx));
        const outcome = await reconcile(
          ctx,
          record,
          async () => {
            /* #345, MWR-042: a section regeneration consumes the immutable
               source and the checked facts and re-asks only the section the
               owner named. Action Items are the one field whose regeneration
               is a new checked output, so only it re-runs the core. */
            const regeneratingActions = request.field === "actionItems";
            const produced = deps.extract
              ? await injectedRevision(record)
              : await produceModelRevision(ctx, record, {
                  useCheckpoints: false,
                  /* Every other field is re-asked from the checked core: a
                     summary regeneration must not rediscover the meeting. */
                  reuseCore: !regeneratingActions,
                });
            const current = currentDebrief(ctx);
            const regenerated = mergeRegeneratedField(current, request.field, produced.extraction);
            /* Unrequested sections keep the state the published revision
               established for them: regenerating the summary is not a claim
               about coaching (#345, MWR-042). */
            const sections = mergeSectionAvailability(
              held?.availability?.sections ?? null,
              produced.sections ?? validatedDebriefSections(),
              request.field,
            );
            return {
              text: resultText(regenerated, transcriptId, sections),
              /* A regenerated Action Item list is this Run's own checked
                 output, so it carries this Run's candidate accounting. Entries
                 the regeneration kept unchanged still materialize under their
                 original keys and keep the records they already have. */
              aliases: produced.aliases,
              sections,
              /* A section regeneration carries the published Action Items
                 forward; regenerating them is a new checked output, and the
                 reconciler materializes it. */
              ...(regeneratingActions ? {} : { retainedOutputs: true }),
              ...(produced.core ? { core: produced.core } : {}),
            };
          },
          "regenerate",
        );
        if (!outcome.completed) {
          throw new DebriefIntegrityError(
            "incomplete-regeneration",
            `${unavailableSections(outcome).join(", ")} did not validate; the previous revision is preserved`,
          );
        }
        const merged = outcome.result;
        const next: MeetingDebriefReviewState = {
          ...state,
          review:
            request.field === "actionItems"
              ? { droppedActionItems: [], completedActionItems: [] }
              : state.review,
          request: null,
        };
        ctx.writeFile("review.json", serializeReviewState(next));
        ctx.event("debrief_regenerated", { field: request.field });
        return merged;
      });
      return {
        status: "done",
        summary: `Regenerated ${request.field} — ${merged.debrief.decisions.length} decision${
          merged.debrief.decisions.length === 1 ? "" : "s"
        }, ${merged.debrief.actionItems.length} action item${
          merged.debrief.actionItems.length === 1 ? "" : "s"
        }`,
        detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
      };
    }

    if (request?.kind === "approve") {
      /* The one gate that survives (goal: automation, except outward writes).
         Approval is what authorises the Gmail draft and the Google Tasks —
         nothing else about the Debrief waits on it. Both adapters are driven
         from Run receipts, so re-entering after a partial failure re-sends
         nothing and creates only what is missing. */
      return ctx.stage("review", async () => {
        /* The durable authority re-asserting the gate. The host route already
           refused synchronously with the same blockers; this catches the race
           where the gate closes between the route saying yes and the Stage
           running. The pending request is cleared so every seam answers
           again, and the Run ends unpublished rather than half-published. */
        const blockers = approvalBlockers(state, gate);
        if (blockers.length > 0) {
          const unlocked: MeetingDebriefReviewState = { ...state, request: null };
          ctx.writeFile("review.json", serializeReviewState(unlocked));
          ctx.event("debrief_approval_refused", { blockers });
          const held = currentDebrief(ctx);
          return {
            status: "done",
            summary: `No email draft — ${blockers.length} thing${
              blockers.length === 1 ? "" : "s"
            } to settle first (${held.actionItems.length} action item${
              held.actionItems.length === 1 ? "" : "s"
            })`,
            detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
          };
        }
        const owner = gate.ownerEmail();
        if (
          state.email &&
          emailPreview(
            ctx.runId,
            record,
            currentDebrief(ctx),
            state,
            owner,
            emailOptions(ctx.runId, record, currentDebrief(ctx), deps.readActionItems ?? null),
            state.email.selectedIds,
          ).revision !== state.email.revision
        ) {
          ctx.writeFile("review.json", serializeReviewState({ ...state, request: null }));
          return {
            status: "done",
            summary: "No draft created. Inputs changed; update the email preview.",
            detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
          };
        }
        const approvedAt = state.approval?.approvedAt ?? now().toISOString();
        const locked: MeetingDebriefReviewState = {
          ...state,
          request: null,
          approval: { approvedAt },
        };
        ctx.writeFile("review.json", serializeReviewState(locked));
        const recipientCount =
          locked.roster.entries.filter((entry) => entry.email !== owner).length +
          locked.recipients.additional.length;
        if (!state.approval) {
          ctx.event("debrief_approved", { approvedAt, recipientCount });
        }
        await writeApprovalOutputs(ctx, deps, record, locked, owner);
        return {
          status: "done",
          summary: `Email draft created for ${recipientCount} recipient${
            recipientCount === 1 ? "" : "s"
          }`,
          detail: { transcriptId, rosterStatus: rosterStatusOf(record), approved: true },
        };
      });
    }

    /* Already published, and re-entered: the outward writes did not all
       finish — a Tasks outage after the draft went out (issue #141, AC 7).
       Both adapters are driven from Run receipts, so this re-sends nothing
       and creates only what is missing. */
    if (state.approval) {
      return ctx.stage("review", async () => {
        const owner = gate.ownerEmail();
        await writeApprovalOutputs(ctx, deps, record, state, owner);
        const recipientCount =
          state.roster.entries.filter((entry) => entry.email !== owner).length +
          state.recipients.additional.length;
        return {
          status: "done",
          summary: `Email draft created for ${recipientCount} recipient${
            recipientCount === 1 ? "" : "s"
          }`,
          detail: { transcriptId, rosterStatus: rosterStatusOf(record), approved: true },
        };
      });
    }

    /* No pending action — a stray re-entry. Nothing to do, and nothing to
       wait for: end the Run as it already was. */
    const debrief = currentDebrief(ctx);
    return {
      status: "done",
      summary: `${debrief.decisions.length} decision${
        debrief.decisions.length === 1 ? "" : "s"
      }, ${debrief.actionItems.length} action item${debrief.actionItems.length === 1 ? "" : "s"}`,
      detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
    };
  };

  return {
    id: MEETING_DEBRIEF_MODULE_ID,
    version: MEETING_DEBRIEF_MODULE_VERSION,

    failureHint(stage: string, reason: string): string {
      if (stage === "associate") return "The Transcript Catalog has no record for this Debrief.";
      if (stage === "extract" || stage === "regenerate") {
        return reason === "extraction failed after 3 attempts"
          ? "Extraction failed after 3 attempts."
          : "Extraction failed. Retry to re-run it.";
      }
      if (stage === "review") return "Review could not complete. Retry to resume it.";
      return reason;
    },

    planRetry(meta) {
      if (meta.status !== "failed" || !meta.failedStage) return null;
      if (meta.failedStage === "associate") {
        return {
          fromStage: meta.failedStage,
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "resume", fromStage: meta.failedStage },
        };
      }
      if (meta.failedStage === "extract") {
        /* No discard: a checked revision that reached the Run is the work
           this retry is resuming (#358). The reconciler finishes an intact
           preparation without a model call, and refuses to regenerate one
           whose accepted bytes are damaged. */
        return {
          fromStage: "extract",
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "resume", fromStage: "extract" },
          resetAttempts: true,
        };
      }
      if (meta.failedStage === "regenerate" || meta.failedStage === "review") {
        return {
          fromStage: "review",
          reason: "failed_stage_is_safe_to_repeat",
          input: { kind: "review", action: "owner" },
        };
      }
      return null;
    },

    planRecovery(state) {
      if (state.status !== "pending" && state.status !== "running") return null;
      /* Both shapes resume the same way: the reconciler decides from the
         committed bytes whether this Run still needs the model (#358). */
      const prepared = state.files.some((name) =>
        /^revision-r\d+\.(manifest|result)\.json$/.test(name),
      );
      return {
        fromStage: "extract",
        reason: prepared ? "debrief_publication_survived_restart" : "debrief_survived_restart",
        input: { kind: "resume", fromStage: "extract" },
      };
    },

    /**
     * Continuing a Run left blocked by an older build. Nothing blocks on
     * review any more, so this exists only to let those Runs finish: it
     * carries them into the review Stage, which settles and ends them.
     */
    planResume(meta) {
      if (meta.status !== "blocked" || !meta.wait) return null;
      return {
        fromStage: meta.wait.stage,
        reason: "owner_review_action",
        input: { kind: "review", action: "owner" },
      };
    },

    async run(ctx: RunContext, input: DebriefInput): Promise<RunOutcome> {
      if (input.kind === "review") {
        return reviewTurn(ctx, input.action);
      }

      const transcriptId =
        input.kind === "fresh" ? input.transcriptId : (ctx.meta().externalId ?? null);
      if (!transcriptId) {
        throw new Error("Debrief Run has no transcript identity");
      }

      // associate — consume the immutable record and the Catalog's review
      // state. Association stays live in the Catalog: later Calendar links
      // prefill the surfaces that read the record, not a frozen copy.
      const record = await ctx.stage("associate", async (): Promise<TranscriptRecord | null> => {
        const record = deps.catalog.getTranscript(transcriptId);
        if (!record) return null;
        const identity = deps.identity.reviewFor(transcriptId);
        ctx.event("association_consumed", {
          linked: record.occurrence !== null,
          occurrenceKey: record.occurrence?.occurrenceKey ?? null,
          rosterSize: record.roster.length,
          mentions: identity.mentions.length,
        });
        return record;
      });
      if (!record) {
        return { status: "skipped", reason: "transcript_not_in_catalog" };
      }

      // extract — the structured retrospective, then the coordinated
      // publication that makes it durable: exact mappings materialized, the
      // review record kept, the pointer published, completion verified
      // (#358). Recovery and retry enter the same reconciler, so an intact
      // prepared revision finishes here without asking the model anything.
      const reconciled = await ctx.stage("extract", async () => {
        const produce =
          input.kind === "reconcile"
            ? undefined
            : async (): Promise<DebriefProducedRevision> =>
                deps.extract
                  ? injectedRevision(record)
                  : produceModelRevision(ctx, record, { useCheckpoints: true, reuseCore: true });
        const outcome = await reconcile(ctx, record, produce);
        /* The checked core is exposed when its required sections did not all
           validate (#345, ADR-0085): the publication is real and review-only,
           and the Run is not done. The failure is what tells a person the
           difference, so the sections that did not validate are named. */
        if (!outcome.completed) {
          throw new DebriefIntegrityError(
            "incomplete-debrief",
            outcome.availability.sections
              .filter((section) => !debriefSectionResolved(section.state))
              .map(
                (section) =>
                  `${section.name} is unavailable (${section.reason ?? "no reason recorded"})`,
              )
              .join("; "),
          );
        }
        return outcome;
      });
      const recounted = reconciled.result;

      /* The Debrief is finished the moment it is published. It used to stop
         here against a thirty-day owner wait, which meant a workspace of
         transcripts sat `blocked` behind a person — the opposite of what this
         app is for. The review record is still written, because the roster,
         the recipients and the done/dismiss decisions are all still real; it
         is simply no longer a gate. The one thing that still waits for the
         owner is the outward writes — the Gmail draft and the Google Tasks —
         which `approve` performs by re-entering this Run. */
      await ctx.stage("review", async () => {
        ensureReviewState(ctx, record);
        ctx.event("debrief_review_started", {
          rosterStatus: rosterStatusOf(record),
        });
      });
      return {
        status: "done",
        summary: `${recounted.debrief.decisions.length} decision${
          recounted.debrief.decisions.length === 1 ? "" : "s"
        }, ${recounted.debrief.actionItems.length} action item${
          recounted.debrief.actionItems.length === 1 ? "" : "s"
        }`,
        detail: { transcriptId, rosterStatus: rosterStatusOf(record) },
      };
    },
  };
}
