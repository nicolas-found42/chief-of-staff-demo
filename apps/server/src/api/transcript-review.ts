import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { TranscriptRelevanceDecisionAction } from "@chief-of-staff-demo/shared";
import type { TranscriptRelevanceService } from "../transcript-catalog/relevance.js";

export interface TranscriptRelevanceApiContext {
  /** The semantic relevance service; routes stay thin over it (issue #127). */
  relevance: TranscriptRelevanceService;
}

const ACTIONS: readonly TranscriptRelevanceDecisionAction[] = ["confirm", "reject", "unresolved"];

function parseLimit(value: unknown): number | "invalid" {
  if (value === undefined) return 0;
  const limit = Number(value);
  return Number.isInteger(limit) && limit > 0 && limit <= 50 ? limit : "invalid";
}

/**
 * The semantic transcript relevance Review surface (issue #127). Like Person
 * Profiles, the Transcript review work is a Workspace resource, not a hosted
 * Module: its routes hang off the Shell under
 * /api/transcripts/review/relevance and stay thin over the service, which
 * owns bounding, citation grounding, and the decision log.
 */
export function registerTranscriptRelevanceApi(
  app: FastifyInstance,
  ctx: TranscriptRelevanceApiContext,
): void {
  const relevance = ctx.relevance;

  app.get("/api/transcripts/review/relevance", async () => ({
    items: relevance.reviewQueue(),
  }));

  app.post(
    "/api/transcripts/review/relevance/search",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const body = (request.body ?? {}) as {
        text?: unknown;
        meeting?: Record<string, unknown>;
        limit?: unknown;
      };
      const text = typeof body.text === "string" ? body.text : "";
      if (!text.trim()) {
        reply.code(400);
        return {
          error: "invalid-query",
          message: "A relevance search needs text to search for.",
        };
      }
      const limit = parseLimit(body.limit);
      if (limit === "invalid") {
        reply.code(400);
        return { error: "invalid-limit", message: "A result limit is an integer from 1 to 50." };
      }
      await relevance.search(
        {
          text,
          ...(body.meeting !== undefined ? { meeting: body.meeting } : {}),
        },
        ...(limit > 0 ? [{ limit }] : []),
      );
      return { items: relevance.reviewQueue() };
    },
  );

  app.post(
    "/api/transcripts/review/relevance/:candidateId/decision",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { candidateId } = request.params as { candidateId: string };
      const body = (request.body ?? {}) as { action?: unknown; note?: unknown };
      const action = body.action;
      if (
        typeof action !== "string" ||
        !ACTIONS.includes(action as TranscriptRelevanceDecisionAction)
      ) {
        reply.code(400);
        return {
          error: "invalid-action",
          message: "A relevance decision is one of: confirm, reject, unresolved.",
        };
      }
      try {
        const decision = relevance.decide({
          candidateId,
          action: action as TranscriptRelevanceDecisionAction,
          ...(typeof body.note === "string" ? { note: body.note } : {}),
        });
        const item = relevance
          .reviewQueue()
          .find((entry) => entry.candidate.id === decision.candidateId);
        return { item };
      } catch (error: unknown) {
        reply.code(404);
        return {
          error: "candidate-not-found",
          message: error instanceof Error ? error.message : "Unknown relevance candidate.",
        };
      }
    },
  );
}
