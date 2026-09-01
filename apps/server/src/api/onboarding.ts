import type { FastifyInstance, FastifyRequest } from "fastify";
import { OwnerOnboarding, OwnerOnboardingError } from "../onboarding/owner.js";

export interface OnboardingApiContext {
  /** The owner-onboarding interface; routes stay thin over it. */
  onboarding: OwnerOnboarding;
}

/**
 * The onboarding product namespace (issue #123): the connected Google
 * identity's owner-Profile proposal and the explicit confirmation that pins
 * it. Every route returns durable resource state or a typed failure
 * classification; no credential material passes through any of them.
 */
export function registerOnboardingApi(app: FastifyInstance, ctx: OnboardingApiContext): void {
  const onboarding = ctx.onboarding;

  app.get("/api/onboarding/owner", async () => {
    return {
      proposal: onboarding.proposal(),
      confirmed: onboarding.confirmed(),
    };
  });

  /* POST, not GET: it writes the durable owner reference. */
  app.post("/api/onboarding/owner/confirm", async (request: FastifyRequest, reply) => {
    const body = (request.body ?? {}) as { profileId?: unknown };
    if (typeof body.profileId !== "string" || !body.profileId.trim()) {
      reply.code(400).send({ error: "invalid-request" });
      return;
    }
    try {
      const confirmed = onboarding.confirm(body.profileId.trim());
      return confirmed;
    } catch (error) {
      if (error instanceof OwnerOnboardingError) {
        reply.code(error.code === "unknown-profile" ? 404 : 409).send({ error: error.code });
        return;
      }
      throw error;
    }
  });
}
