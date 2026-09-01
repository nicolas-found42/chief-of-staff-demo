import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type {
  PersonProfileCorrectionInput,
  PersonProfileCreateInput,
  PersonProfileDetachInput,
  PersonProfileMergeInput,
  PersonProfileProjectionPurpose,
} from "@chief-of-staff-demo/shared";
import {
  PersonProfileValidationError,
  WorkspacePersonProfiles,
} from "../person-profile/profiles.js";

export interface PeopleApiContext {
  /** The Workspace-owned Person Profiles interface; routes stay thin over it. */
  people: WorkspacePersonProfiles;
}

const PURPOSES: readonly PersonProfileProjectionPurpose[] = ["public-safe", "meeting"];

function parseRevision(value: string | undefined): number | "invalid" | "unset" {
  if (value === undefined || value === "") return "unset";
  const revision = Number(value);
  return Number.isInteger(revision) && revision > 0 ? revision : "invalid";
}

/** Failure classification for a projection request that names no real purpose. */
function isInvalidPurpose(value: string | undefined): boolean {
  return !PURPOSES.includes(value as PersonProfileProjectionPurpose);
}

/**
 * The Person Profiles product namespace (spec #117): search, explicit manual
 * creation, current and exact-revision retrieval, and consumer projections.
 * Every route returns durable resource state or a typed failure
 * classification, never provider-specific detail.
 */
export function registerPeopleApi(app: FastifyInstance, ctx: PeopleApiContext): void {
  const people = ctx.people;

  app.get("/api/people", async (request: FastifyRequest) => {
    const query = request.query as { query?: string; includeArchived?: string };
    return people.search({
      ...(query.query === undefined ? {} : { query: query.query }),
      includeArchived: query.includeArchived === "true",
    });
  });

  app.post("/api/people", async (request: FastifyRequest, reply) => {
    try {
      const input: PersonProfileCreateInput = request.body ?? {};
      const profile = people.create(input);
      reply.code(201);
      return profile;
    } catch (error) {
      if (error instanceof PersonProfileValidationError) {
        reply.code(400);
        return { error: error.code, message: error.message };
      }
      throw error;
    }
  });

  app.get("/api/people/:profileId", async (request: FastifyRequest, reply) => {
    const { profileId } = request.params as { profileId: string };
    const profile = people.get(profileId);
    if (!profile) {
      reply.code(404);
      return { error: "profile-not-found", message: "No Person Profile with that id." };
    }
    return profile;
  });

  app.get("/api/people/:profileId/revisions", async (request: FastifyRequest, reply) => {
    const { profileId } = request.params as { profileId: string };
    const revisions = people.revisions(profileId);
    if (revisions.length === 0 && !people.get(profileId)) {
      reply.code(404);
      return { error: "profile-not-found", message: "No Person Profile with that id." };
    }
    return revisions;
  });

  app.get("/api/people/:profileId/revisions/:revision", async (request: FastifyRequest, reply) => {
    const { profileId, revision } = request.params as { profileId: string; revision: string };
    const parsed = parseRevision(revision);
    if (parsed === "invalid" || parsed === "unset") {
      reply.code(400);
      return { error: "invalid-revision", message: "A revision is a positive integer." };
    }
    const profile = people.getRevision(profileId, parsed);
    if (!profile) {
      reply.code(404);
      return {
        error: "revision-not-found",
        message: "No such revision of that Person Profile.",
      };
    }
    return profile;
  });

  app.get("/api/people/:profileId/projection", async (request: FastifyRequest, reply) => {
    const { profileId } = request.params as { profileId: string };
    const query = request.query as { purpose?: string; revision?: string };
    if (isInvalidPurpose(query.purpose)) {
      reply.code(400);
      return {
        error: "invalid-purpose",
        message: "A projection purpose is one of: public-safe, meeting.",
      };
    }
    const parsed = parseRevision(query.revision);
    if (parsed === "invalid") {
      reply.code(400);
      return { error: "invalid-revision", message: "A revision is a positive integer." };
    }
    const projection = people.project(
      query.purpose as PersonProfileProjectionPurpose,
      profileId,
      parsed === "unset" ? undefined : { revision: parsed },
    );
    if (!projection) {
      reply.code(404);
      return {
        error: "profile-not-found",
        message: "No Person Profile with that id, or no such revision of it.",
      };
    }
    return projection;
  });

  /**
   * Identity repair (ticket #121): an ordinary factual correction appends a
   * revision; the superseded snapshot stays readable and the correction is
   * filed as an audited invalidation of the revision it superseded.
   */
  app.post("/api/people/:profileId/corrections", async (request: FastifyRequest, reply) => {
    try {
      const input = (request.body ?? {}) as PersonProfileCorrectionInput;
      const { profileId } = request.params as { profileId: string };
      return people.correct(profileId, input);
    } catch (error) {
      return repairFailure(reply, error);
    }
  });
  /** Identity repair (ticket #121): merge a duplicate Profile away into this
      one through an audited decision; conflicting facts must be resolved. */
  app.post("/api/people/:profileId/merges", async (request: FastifyRequest, reply) => {
    try {
      const input = (request.body ?? {}) as PersonProfileMergeInput;
      const { profileId } = request.params as { profileId: string };
      return people.merge(profileId, input);
    } catch (error) {
      return repairFailure(reply, error);
    }
  });

  /** Identity repair (ticket #121): detach one evidence record, optionally
      splitting it onto the correct Profile. */
  app.post("/api/people/:profileId/detachments", async (request: FastifyRequest, reply) => {
    try {
      const input = (request.body ?? {}) as PersonProfileDetachInput;
      const { profileId } = request.params as { profileId: string };
      return people.detachEvidence(profileId, input);
    } catch (error) {
      return repairFailure(reply, error);
    }
  });

  /** The Profile's append-only invalidation log: consumers poll it to know
      when the projections and derived claims they hold need explicit refresh. */
  app.get("/api/people/:profileId/invalidations", async (request: FastifyRequest, reply) => {
    const { profileId } = request.params as { profileId: string };
    if (!people.get(profileId)) {
      reply.code(404);
      return { error: "profile-not-found", message: "No Person Profile with that id." };
    }
    return people.invalidations(profileId);
  });
}

/** Typed failure classification for identity repair routes: 404 for unknown
    resources, 400 for a named decision problem. */
function repairFailure(reply: FastifyReply, error: unknown): void {
  if (error instanceof PersonProfileValidationError) {
    reply.code(
      error.code === "profile-not-found" || error.code === "evidence-not-found" ? 404 : 400,
    );
    reply.header("content-type", "application/json; charset=utf-8");
    reply.send({ error: error.code, message: error.message });
    return;
  }
  throw error;
}
