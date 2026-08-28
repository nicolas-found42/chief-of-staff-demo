import type { FastifyInstance } from "fastify";
import type { ConfigStore } from "../../../config.js";
import { HubSpotConnection } from "./connection.js";

export interface HubSpotRouteOptions {
  configStore: ConfigStore;
}

export function registerMeetingBriefHubSpotRoutes(
  app: FastifyInstance,
  options: HubSpotRouteOptions,
): void {
  const { configStore } = options;

  app.get("/api/meeting-brief/hubspot/status", async () => {
    const connection = new HubSpotConnection(configStore);
    return connection.status();
  });

  app.post("/api/meeting-brief/hubspot/connect", async (request, reply) => {
    const token = (request.body as { token?: unknown } | undefined)?.token;
    if (typeof token !== "string" || token.trim() === "") {
      reply.code(400).send({ error: "A HubSpot private-app token is required." });
      return;
    }
    try {
      const connection = new HubSpotConnection(configStore);
      const status = await connection.connect(token);
      return status;
    } catch (error) {
      reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      return;
    }
  });

  app.post("/api/meeting-brief/hubspot/disconnect", async () => {
    const connection = new HubSpotConnection(configStore);
    return connection.disconnect();
  });

  app.post("/api/meeting-brief/hubspot/check", async () => {
    const connection = new HubSpotConnection(configStore);
    return connection.verifySetup();
  });

  // Internal domains — normalized case-insensitive, stored via Module config.
  // Exposed here even though eligibility is issue 83, to keep Settings unified.
  app.get("/api/meeting-brief/config", async () => {
    const modules = configStore.get().modules["meeting-brief-generator"];
    const hubspot = new HubSpotConnection(configStore).status();
    return {
      internalDomains: modules.internalDomains,
      hubspot,
    };
  });

  app.put("/api/meeting-brief/config", async (request, reply) => {
    const body = request.body as { internalDomains?: unknown };
    if (body.internalDomains !== undefined && !Array.isArray(body.internalDomains)) {
      reply.code(400).send({ error: "internalDomains must be an array of strings." });
      return;
    }
    const current = configStore.get().modules["meeting-brief-generator"];
    let nextDomains = current.internalDomains;
    if (Array.isArray(body.internalDomains)) {
      const raw = body.internalDomains as unknown[];
      const normalized = raw
        .filter((d): d is string => typeof d === "string")
        .map((d) => d.trim().toLowerCase())
        .filter((d) => d.length > 0)
        .filter((d, idx, arr) => arr.indexOf(d) === idx)
        .sort();
      // Validate domains look like domains (simple check: contains dot)
      for (const d of normalized) {
        if (!d.includes(".") || d.startsWith(".") || d.endsWith(".")) {
          reply.code(400).send({ error: `Invalid domain: ${d}` });
          return;
        }
      }
      nextDomains = normalized;
    }
    const next = { ...current, internalDomains: nextDomains };
    configStore.setModuleConfig("meeting-brief-generator", next);
    const updated = configStore.get().modules["meeting-brief-generator"];
    return {
      internalDomains: updated.internalDomains,
      hubspot: new HubSpotConnection(configStore).status(),
    };
  });
}
