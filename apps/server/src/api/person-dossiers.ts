import { PersonDossierQueries } from "../person-profile/dossier-queries.js";
import type { FastifyInstance } from "fastify";
import {
  type PersonRelationshipRecord,
  PersonDossierQuerySchema,
  PersonResearchSettingsSchema,
} from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import type { PersonDossierStore } from "../person-profile/dossier-store.js";
import type { PersonResearchQueue } from "../person-profile/research-queue.js";

export function registerPersonDossierApi(
  app: FastifyInstance,
  deps: {
    people: WorkspacePersonProfiles;
    dossiers: PersonDossierStore;
    queue: PersonResearchQueue;
    history?: (profileId: string) => PersonRelationshipRecord[];
  },
): void {
  /* The bounded per-profile summary (issue #418, T5, spec §7), not the whole
     PersonResearchJob: the dossier response used to carry the unbounded
     research-job payload (full attempt ledger, checkpoint, visited-lead
     lists) alongside the dossier itself (#417 F4). */
  const view = (id: string) => ({
    dossier: deps.dossiers.get(id),
    profile: deps.people.get(id),
    readiness: deps.queue.readiness(),
    research: deps.queue.summary(id),
  });
  app.get<{ Params: { profileId: string; revision: string } }>(
    "/api/people/:profileId/dossier/revisions/:revision",
    async (request, reply) => {
      const revision = Number(request.params.revision);
      if (!Number.isInteger(revision) || revision < 1)
        return reply.code(400).send({ error: "invalid-revision" });
      return (
        deps.dossiers.getRevision(request.params.profileId, revision) ??
        reply.code(404).send({ error: "revision-not-found" })
      );
    },
  );
  app.get<{ Params: { profileId: string } }>(
    "/api/people/:profileId/relationship-history",
    async (request, reply) => {
      if (!deps.people.get(request.params.profileId))
        return reply.code(404).send({ error: "profile-not-found" });
      return deps.history?.(request.params.profileId) ?? [];
    },
  );
  const queries = new PersonDossierQueries(deps);
  app.get<{ Params: { profileId: string } }>(
    "/api/people/:profileId/dossier-analysis",
    async (request, reply) =>
      queries.analyse(request.params.profileId, "private") ??
      reply.code(404).send({ error: "dossier-not-found" }),
  );
  app.get<{ Querystring: { from?: string; to?: string } }>(
    "/api/people/connection-path",
    async (request, reply) => {
      if (!request.query.from || !request.query.to)
        return reply.code(400).send({ error: "two-profiles-required" });
      return {
        path: queries.connectionPath(request.query.from, request.query.to, "private"),
        scope:
          "Documented connections only. A path does not establish an introduction, access, willingness or availability.",
      };
    },
  );
  app.post("/api/people/dossier-query", async (request, reply) => {
    const input = PersonDossierQuerySchema.safeParse(request.body);
    if (!input.success) return reply.code(400).send({ error: "invalid-dossier-query" });
    return queries.search(input.data);
  });
  /* The independently bounded queue-wide projection (issue #418, T5, spec
     §7), not the whole-queue clone `status()` deep-copies every job for
     (#417 F4): this route is what the dossier panel polled every cycle. */
  app.get("/api/people/research/status", async () => ({
    ...deps.queue.aggregate(),
    readiness: deps.queue.readiness(),
  }));
  app.patch("/api/people/research/settings", async (request, reply) => {
    const parsed = PersonResearchSettingsSchema.partial().strict().safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error: "invalid-research-settings",
        message: "Research limits must be within the supported ranges.",
      });
    /* The queue owns the merge onto its live settings; sending it a whole
       object here would re-assert `paused` on every unrelated edit and cancel
       in-flight research for a changed refresh interval (#207). */
    deps.queue.configure(parsed.data);
    return deps.queue.aggregate();
  });
  app.get<{ Params: { profileId: string }; Querystring: { cursor?: string } }>(
    "/api/people/:profileId/research/summary",
    async (request, reply) => {
      const id = request.params.profileId;
      if (!deps.people.get(id)) return reply.code(404).send({ error: "profile-not-found" });
      /* Side-effect-free (issue #418, T5, spec §7): this is what normal
         polling reads instead of the dossier route, and it never enqueues. */
      return { summary: deps.queue.summary(id), readiness: deps.queue.readiness() };
    },
  );
  /* Bounded display facts for the Profile's retained sources (UX audit F6):
     titles, sites and capture dates a reader tells citations apart with —
     never the retained text, which stays behind the per-source route. */
  app.get<{ Params: { profileId: string } }>(
    "/api/people/:profileId/sources",
    async (request, reply) => {
      const id = request.params.profileId;
      if (!deps.people.get(id)) return reply.code(404).send({ error: "profile-not-found" });
      return { sources: deps.dossiers.sourceSummaries(deps.dossiers.get(id)?.sourceIds ?? []) };
    },
  );
  /* An owner's explicit stop for this Profile's research (UX audit F7); the
     queue answers false when there is nothing running or queued to stop. */
  app.post<{ Params: { profileId: string } }>(
    "/api/people/:profileId/research/cancel",
    async (request, reply) => {
      const id = request.params.profileId;
      if (!deps.people.get(id)) return reply.code(404).send({ error: "profile-not-found" });
      return { cancelled: deps.queue.cancel(id) };
    },
  );
  app.get<{ Params: { profileId: string }; Querystring: { cursor?: string } }>(
    "/api/people/:profileId/research/diagnostics",
    async (request, reply) => {
      const id = request.params.profileId;
      if (!deps.people.get(id)) return reply.code(404).send({ error: "profile-not-found" });
      /* Paged, source-free operation detail on explicit demand (spec §7);
         side-effect-free like the summary route. */
      return deps.queue.diagnostics(
        id,
        request.query.cursor === undefined ? {} : { cursor: request.query.cursor },
      );
    },
  );
  app.get<{ Params: { profileId: string } }>(
    "/api/people/:profileId/dossier",
    async (request, reply) => {
      const id = request.params.profileId;
      if (!deps.people.get(id)) return reply.code(404).send({ error: "profile-not-found" });
      /* A dossier read stays a read (issue #418, T3): the viewed-Profile
         scheduling side effect is retained, but its decision is exposed
         rather than turning a readable dossier into an error — even when
         research is not ready to accept it. */
      const researchDecision = deps.queue.enqueue(id, "viewed");
      return { ...view(id), researchDecision };
    },
  );
  app.post<{ Params: { profileId: string } }>(
    "/api/people/:profileId/research",
    async (request, reply) => {
      const id = request.params.profileId;
      const person = deps.people.get(id);
      if (!person) return reply.code(404).send({ error: "profile-not-found" });
      if (person.archivedAt || person.mergedInto)
        return reply.code(409).send({ error: "profile-inactive" });
      const decision = deps.queue.enqueue(id, "explicit");
      /* 202 only when work is genuinely queued or already accepted (issue
         #418, T3; #417 F1): every other decision names why nothing was
         accepted instead of a false-positive "prioritised" response. */
      if (decision.kind === "accepted" || decision.kind === "already-active")
        return reply.code(202).send({ ...view(id), researchDecision: decision });
      if (decision.kind === "rejected-readiness") {
        const { readiness } = decision;
        return readiness.state === "initializing"
          ? reply.code(503).send({ error: "research-initializing", readiness })
          : reply.code(409).send({
              error: "research-disabled",
              readiness,
              ...(readiness.nextAction ? { nextAction: readiness.nextAction } : {}),
            });
      }
      if (decision.kind === "inactive-profile")
        return reply.code(409).send({ error: "profile-inactive" });
      /* "deferred" cannot occur for the "explicit" reason this route always
         sends — it is always urgent — but every decision is handled rather
         than assumed. */
      return reply.code(200).send({ ...view(id), researchDecision: decision });
    },
  );
  app.post<{ Params: { profileId: string; sourceId: string } }>(
    "/api/people/:profileId/sources/:sourceId/detach",
    async (request, reply) => {
      const { profileId, sourceId } = request.params;
      if (!deps.people.get(profileId) || !deps.dossiers.source(profileId, sourceId))
        return reply.code(404).send({ error: "source-not-found" });
      deps.queue.remove(profileId);
      deps.dossiers.detach(profileId, sourceId);
      deps.people.forgetResearchSource(profileId, sourceId);
      return view(profileId);
    },
  );
  app.get<{ Params: { profileId: string; sourceId: string } }>(
    "/api/people/:profileId/sources/:sourceId",
    async (request, reply) => {
      const { profileId, sourceId } = request.params;
      if (!deps.people.get(profileId)) return reply.code(404).send({ error: "profile-not-found" });
      const source = deps.dossiers.source(profileId, sourceId);
      return source ?? reply.code(404).send({ error: "source-not-found" });
    },
  );
}
