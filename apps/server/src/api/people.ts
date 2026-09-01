import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  PersonProfileCreateInput,
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
}
