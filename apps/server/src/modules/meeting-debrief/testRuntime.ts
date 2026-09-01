import type {
  IdentityDecision,
  MeetingDebriefExtraction,
  OrganizationMention,
  TranscriptMention,
  TranscriptRecord,
} from "@chief-of-staff-demo/shared";
import type { FastifyInstance } from "fastify";
import type { Runs } from "../../runs.js";
import { TranscriptCatalogStore } from "../../transcript-catalog/store.js";
import { TranscriptIdentityStore } from "../../transcript-catalog/identity-store.js";
import { MEETING_DEBRIEF_MODULE_ID } from "@chief-of-staff-demo/shared";
import { MeetingDebriefHost } from "./host.js";

export interface MeetingDebriefTestRuntimeOptions {
  runs: Runs;
  workspaceDir: string;
  log?: (message: string) => void;
}

/** What the hermetic seed route accepts for one transcript's identity state. */
interface SeedIdentityState {
  mentions?: TranscriptMention[];
  decisions?: IdentityDecision[];
  organizations?: OrganizationMention[];
}

interface MeetingDebriefSeedPayload {
  /** The immutable record exactly as the Catalog would have registered it. */
  transcript: TranscriptRecord;
  identity?: SeedIdentityState;
}

export interface MeetingDebriefTestRuntime {
  host: MeetingDebriefHost;
  /** Writes the immutable artifact + identity state, then hands the record to
   *  the host at the exact seam the Catalog calls on mining completion. */
  seed(payload: MeetingDebriefSeedPayload): Promise<string>;
}

/**
 * Deterministic extraction for the hermetic journey: it derives the structured
 * debrief from the record's own lines and resolves owners against the Catalog
 * review state the same way the model-backed path must — by naming the mention
 * whose surface text the owner matches.
 */
function deterministicDebriefExtraction(
  record: TranscriptRecord,
  identity: { mentions: TranscriptMention[] },
): MeetingDebriefExtraction {
  const lines = record.normalizedText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const speakerOf = (line: string): string | null => {
    const separator = line.indexOf(":");
    return separator > 0 ? line.slice(0, separator).trim() : null;
  };
  const decisionLine =
    lines.find((line) => /decided|agreed|we will ship|decision/i.test(line)) ?? lines[0] ?? "";
  const actionLine =
    lines.find((line) => /\bI will\b|\bwill own\b|\bfollow up\b|\btake a look\b/i.test(line)) ?? "";
  const questionLine = lines.find((line) => line.includes("?")) ?? "";

  const mentionForSurface = (surface: string | null): TranscriptMention | null => {
    if (!surface) return null;
    const needle = surface.toLowerCase();
    return (
      identity.mentions.find(
        (mention) =>
          mention.surfaceText.toLowerCase() === needle || mention.normalizedForms.includes(needle),
      ) ?? null
    );
  };

  const actionOwner = speakerOf(actionLine);
  const actionMention = mentionForSurface(actionOwner);
  const decisionSpeaker = speakerOf(decisionLine);
  const questionSpeaker = speakerOf(questionLine);

  return {
    version: 1,
    summary: `Retrospective of ${record.source.fileName}: ${decisionLine || "no decision line found"}`,
    decisions: [
      {
        statement: decisionLine || "No explicit decision was recorded",
        evidence: decisionLine || null,
      },
    ],
    actionItems: actionLine
      ? [
          {
            title: actionLine.replace(/^[^:]*:\s*/, ""),
            owner: actionOwner ?? actionMention?.surfaceText ?? null,
            ownerMentionId: actionMention?.id ?? null,
            ownerProfileId: null,
            dueDate: record.meetingDate,
          },
        ]
      : [],
    openQuestions: questionLine
      ? [{ question: questionLine.replace(/^[^:]*:\s*/, ""), raisedBy: questionSpeaker }]
      : [],
    effectivenessEvidence: `The transcript has ${lines.length} utterance lines; the decision was stated by ${
      decisionSpeaker ?? "an unidentified speaker"
    }.`,
    coachingAdvice: "Close open questions in the next session and confirm the roster.",
  };
}

/**
 * Hermetic runtime for the browser journey (ENABLE_TEST_SEED=1). Everything
 * the production runtime reads is real — the Workspace Catalog store and the
 * identity store — only the extraction is deterministic, so the journey can
 * never depend on a live model.
 */
export function createMeetingDebriefTestRuntime(
  options: MeetingDebriefTestRuntimeOptions,
): MeetingDebriefTestRuntime {
  const catalogStore = new TranscriptCatalogStore(options.workspaceDir);
  const identityStore = new TranscriptIdentityStore(options.workspaceDir);
  const host = new MeetingDebriefHost({
    runs: options.runs,
    catalog: {
      getTranscript: (transcriptId) => catalogStore.readTranscript(transcriptId),
    },
    identity: {
      reviewFor: (transcriptId) => ({
        mentions: identityStore
          .readMentions()
          .filter((mention) => mention.provenance.transcriptId === transcriptId),
        decisions: identityStore
          .readDecisions()
          .filter((decision) => decision.transcriptId === transcriptId),
        organizations: identityStore
          .readOrganizations()
          .filter((organization) => organization.provenance.transcriptId === transcriptId),
      }),
    },
    extract: async ({ record, identity }) =>
      deterministicDebriefExtraction(record, { mentions: identity.mentions }),
    ...(options.log ? { log: options.log } : {}),
  });

  return {
    host,
    async seed(payload: MeetingDebriefSeedPayload): Promise<string> {
      const record = payload.transcript;
      if (payload.identity?.mentions) {
        identityStore.replaceMentions(record.id, payload.identity.mentions);
      }
      if (payload.identity?.organizations) {
        identityStore.replaceOrganizations(record.id, payload.identity.organizations);
      }
      if (payload.identity?.decisions) {
        for (const decision of payload.identity.decisions) {
          identityStore.appendDecision(decision);
        }
      }
      catalogStore.saveTranscript(record);
      await host.process(record);
      const summary = options.runs
        .list({ module: MEETING_DEBRIEF_MODULE_ID })
        .runs.find((entry) => {
          const meta = options.runs.open(entry.id)?.read();
          return meta?.externalId === record.id;
        });
      if (!summary) {
        throw new Error(`Meeting Debrief Run was not created for ${record.id}`);
      }
      return summary.id;
    },
  };
}

export function registerMeetingDebriefTestRoutes(
  app: FastifyInstance,
  runtime: MeetingDebriefTestRuntime,
): void {
  app.post("/api/test/meeting-debrief/seed", async (request, reply) => {
    const payload = request.body as MeetingDebriefSeedPayload;
    if (!payload.transcript.id) {
      reply.code(400).send({ error: "seed requires a transcript with an id" });
      return;
    }
    const runId = await runtime.seed(payload);
    return { runId };
  });
}
