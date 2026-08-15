import {
  DEFAULT_SERVICE_PORT,
  PROTOCOL_VERSION,
  SERVICE_VERSION,
  type ApiErrorBody,
  type ConfigResponse,
  type HealthResponse,
  type RunDetailResponse,
  type RunSummary,
} from "@chief-of-staff/contracts";
import { WorkflowError } from "@chief-of-staff/workflow";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { readFile, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import type { ServiceRuntime } from "../runtime.js";

export interface ApiServerOptions {
  runtime: ServiceRuntime;
  host: string;
  port: number;
  uiDistDir?: string;
  log: (message: string) => void;
}

const PAIRING_LIMIT = 20;
const MUTATION_LIMIT = 60;

function errorBody(code: string, message: string, fields?: Array<{ field: string; message: string }>): ApiErrorBody {
  return { error: { code, message, ...(fields ? { fields } : {}) } };
}

export class ApiServer {
  private app: FastifyInstance;
  private sessionTokens = new Map<string, number>();
  private requestCounts = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly options: ApiServerOptions) {
    this.app = Fastify({
      logger: false,
      bodyLimit: 30 * 1024 * 1024,
      trustProxy: false,
    });
  }

  private allowedOrigin(origin: string | undefined): boolean {
    if (!origin) {
      return true;
    }
    const origins = this.options.runtime.config?.app.allowedUiOrigins ?? [];
    return origins.includes(origin);
  }

  private rateLimit(key: string, limit: number): void {
    const now = Date.now();
    const entry = this.requestCounts.get(key);
    if (!entry || entry.resetAt < now) {
      this.requestCounts.set(key, { count: 1, resetAt: now + 60_000 });
      return;
    }
    entry.count += 1;
    if (entry.count > limit) {
      throw new WorkflowError("RATE_LIMITED", "Too many requests; try again shortly");
    }
  }


  private sessionTokenFor(request: FastifyRequest): string | null {
    const header = request.headers.authorization;
    if (typeof header !== "string" || !header.startsWith("Bearer ")) {
      return null;
    }
    const token = header.slice("Bearer ".length).trim();
    const expiresAt = this.sessionTokens.get(token);
    if (expiresAt === undefined || expiresAt < Date.now()) {
      return null;
    }
    return token;
  }

  private async requireAuth(request: FastifyRequest): Promise<string> {
    const token = this.sessionTokenFor(request);
    if (!token) {
      throw new WorkflowError("INVALID_CONFIGURATION", "A valid session token is required");
    }
    return token;
  }

  private contentTypeFor(path: string): string {
    const ext = extname(path).toLowerCase();
    if (ext === ".html") return "text/html; charset=utf-8";
    if (ext === ".js") return "text/javascript; charset=utf-8";
    if (ext === ".css") return "text/css; charset=utf-8";
    if (ext === ".json") return "application/json; charset=utf-8";
    if (ext === ".svg") return "image/svg+xml";
    if (ext === ".png") return "image/png";
    if (ext === ".ico") return "image/x-icon";
    return "application/octet-stream";
  }

  private registerRoutes(): void {
    const app = this.app;

    app.get("/v1/health", async (request, reply) => {
      const origin = request.headers.origin;
      if (!this.allowedOrigin(origin)) {
        return reply.code(403).send(errorBody("INVALID_CONFIGURATION", "Origin is not allowed"));
      }
      const readiness = this.options.runtime.readiness();
      const body: HealthResponse = {
        serviceVersion: SERVICE_VERSION,
        protocolVersion: PROTOCOL_VERSION,
        workspace: {
          status: readiness.definitionValid ? "ready" : "error",
          ...(readiness.definitionValid ? {} : { errorCode: "WORKFLOW_DEFINITION_CHANGED" }),
        },
        pairing: this.options.runtime.pairingStatus(),
      };
      return reply.send(body);
    });

    app.post("/v1/pair", async (request, reply) => {
      const origin = request.headers.origin;
      if (!this.allowedOrigin(origin)) {
        return reply.code(403).send(errorBody("INVALID_CONFIGURATION", "Origin is not allowed"));
      }
      try {
        this.rateLimit("pair", PAIRING_LIMIT);
        const body = (request.body ?? {}) as { code?: string };
        const token = this.options.runtime.exchangePairingCode(String(body.code ?? ""));
        const expiresAt = new Date(Date.now() + 12 * 60 * 60_000).toISOString();
        this.sessionTokens.set(token, Date.parse(expiresAt));
        return reply.send({ sessionToken: token, expiresAt });
      } catch (error) {
        const workflowError = error as WorkflowError;
        const status = workflowError.code === "RATE_LIMITED" ? 429 : 400;
        reply.code(status);
        return reply.send(
          errorBody(
            workflowError.code ?? "INVALID_CONFIGURATION",
            workflowError.message
          )
        );
      }
    });


    const authRoutes = async (request: FastifyRequest, reply: { code: (n: number) => unknown; send: (b: unknown) => unknown }): Promise<boolean> => {
      const origin = request.headers.origin;
      if (!this.allowedOrigin(origin)) {
        await reply.send({ error: { code: "INVALID_CONFIGURATION", message: "Origin is not allowed" } });
        reply.code(403);
        return false;
      }
      try {
        await this.requireAuth(request);
        return true;
      } catch {
        reply.code(401);
        await reply.send(errorBody("INVALID_CONFIGURATION", "A valid session token is required"));
        return false;
      }
    };

    app.get("/v1/config", async (request, reply) => {
      const ok = await authRoutes(request, reply as never);
      if (!ok) return reply;
      const runtime = this.options.runtime;
      const config = runtime.config;
      if (!config) {
        return reply.code(503).send(errorBody("INVALID_CONFIGURATION", "Service is not configured"));
      }
      const body: ConfigResponse = {
        profile: config.profile,
        models: config.models,
        app: config.app,
        calendar: config.calendar,
        openRouterConfigured: Boolean(process.env.OPENROUTER_API_KEY),
        readiness: runtime.readiness(),
      };
      return reply.send(body);
    });

    const putJson = async <T>(
      request: FastifyRequest,
      reply: { code: (n: number) => unknown; send: (b: unknown) => unknown },
      handler: (value: T) => Promise<T>
    ): Promise<unknown> => {
      if (!(await authRoutes(request, reply as never))) {
        return reply;
      }
      this.rateLimit("mutation", MUTATION_LIMIT);
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.includes("application/json")) {
        reply.code(415);
        return reply.send(errorBody("INVALID_CONFIGURATION", "Content-Type must be application/json"));
      }
      try {
        const value = (request.body ?? {}) as T;
        return reply.send(await handler(value));
      } catch (error) {
        const workflowError = error as WorkflowError;
        reply.code(400);
        return reply.send(errorBody(workflowError.code ?? "INVALID_CONFIGURATION", workflowError.message));
      }
    };

    app.put("/v1/config/profile", async (request, reply) =>
      putJson(request, reply as never, (value) => this.options.runtime.configStoreReplace("profile", value))
    );
    app.put("/v1/config/models", async (request, reply) =>
      putJson(request, reply as never, (value) => this.options.runtime.configStoreReplace("models", value))
    );
    app.put("/v1/calendar", async (request, reply) =>
      putJson(request, reply as never, (value) => this.options.runtime.configStoreReplace("calendar", value))
    );

    app.post("/v1/transcripts", async (request, reply) => {
      if (!(await authRoutes(request, reply as never))) {
        return reply;
      }
      this.rateLimit("mutation", MUTATION_LIMIT);
      let data: Buffer;
      try {
        const part = await request.file();
        if (!part) {
          reply.code(400);
          return reply.send(errorBody("SOURCE_UNSUPPORTED", "A transcript file is required"));
        }
        data = await part.toBuffer();
        const runId = await this.options.runtime.uploadTranscript(part.filename, new Uint8Array(data));
        return reply.send({ runId, claimed: true });
      } catch (error) {
        const workflowError = error as WorkflowError;
        const status = workflowError.code === "SOURCE_TOO_LARGE" ? 413 : 400;
        reply.code(status);
        return reply.send(errorBody(workflowError.code ?? "SOURCE_UNSUPPORTED", workflowError.message));
      }
    });

    app.get("/v1/runs", async (request, reply) => {
      if (!(await authRoutes(request, reply as never))) {
        return reply;
      }
      const summaries = await this.options.runtime.listRunSummaries();
      return reply.send({ total: summaries.length, runs: summaries });
    });

    app.get<{ Params: { runId: string } }>("/v1/runs/:runId", async (request, reply) => {
      if (!(await authRoutes(request, reply as never))) {
        return reply;
      }
      const detail = await this.options.runtime.getRunDetail(request.params.runId);
      if (!detail) {
        reply.code(404);
        return reply.send(errorBody("INVALID_CONFIGURATION", `Unknown run ${request.params.runId}`));
      }
      return reply.send(detail);
    });

    app.get<{ Params: { runId: string }; Querystring: { after?: string } }>(
      "/v1/runs/:runId/events",
      async (request, reply) => {
        if (!(await authRoutes(request, reply as never))) {
          return reply;
        }
        const runId = request.params.runId;
        let after = Number(request.query.after ?? 0);
        if (!Number.isFinite(after)) {
          after = 0;
        }
        const eventsPath = join(this.options.runtime.workspace.root, "runs", runId, "events.jsonl");
        reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
        reply.header("Cache-Control", "no-cache");
        reply.raw.flushHeaders();
        const manifest = await this.options.runtime.readManifest(runId);
        const active = manifest !== null && (manifest.status === "running" || manifest.status === "interrupted");
        let cursor = 0;
        let text = "";
        try {
          text = await readFile(eventsPath, "utf8");
        } catch {
          text = "";
        }
        const emitNewLines = (): number => {
          const fresh = text.slice(cursor);
          cursor = text.length;
          const lines = fresh
            .split("\n")
            .filter((line) => line.trim().length > 0)
            .filter((line) => {
              const parsed = JSON.parse(line) as { sequence: number };
              return parsed.sequence > after;
            });
          if (lines.length > 0) {
            reply.raw.write(`${lines.join("\n")}\n`);
          }
          return lines.length;
        };
        emitNewLines();
        if (!active) {
          reply.raw.end();
          return reply;
        }
        // Live tail: append new events until the run settles or the client
        // disconnects.
        let closed = false;
        reply.raw.on("close", () => {
          closed = true;
        });
        while (!closed) {
          await new Promise((resolve) => setTimeout(resolve, 400));
          try {
            const updated = await readFile(eventsPath, "utf8");
            if (updated.length > text.length) {
              text = updated;
              emitNewLines();
            }
          } catch {
            // File not yet written; keep waiting.
          }
          const current = await this.options.runtime.readManifest(runId);
          if (!current || (current.status !== "running" && current.status !== "interrupted")) {
            break;
          }
        }
        reply.raw.end();
        return reply;
      }
    );

    app.post<{ Params: { runId: string } }>("/v1/runs/:runId/cancel", async (request, reply) => {
      if (!(await authRoutes(request, reply as never))) {
        return reply;
      }
      try {
        this.options.runtime.cancelRun(request.params.runId);
        return reply.send({ runId: request.params.runId, status: "cancelled" });
      } catch (error) {
        const workflowError = error as WorkflowError;
        reply.code(400);
        return reply.send(errorBody(workflowError.code ?? "INVALID_CONFIGURATION", workflowError.message));
      }
    });

    app.post<{ Params: { runId: string } }>("/v1/runs/:runId/retry", async (request, reply) => {
      if (!(await authRoutes(request, reply as never))) {
        return reply;
      }
      try {
        const manifest = await this.options.runtime.retryRun(request.params.runId);
        return reply.send({ runId: request.params.runId, status: manifest.status });
      } catch (error) {
        const workflowError = error as WorkflowError;
        reply.code(400);
        return reply.send(errorBody(workflowError.code ?? "INVALID_CONFIGURATION", workflowError.message));
      }
    });

    app.post<{ Params: { runId: string } }>("/v1/runs/:runId/rerun", async (request, reply) => {
      if (!(await authRoutes(request, reply as never))) {
        return reply;
      }
      try {
        const manifest = await this.options.runtime.rerunRun(request.params.runId);
        return reply.send({ runId: manifest.runId, status: manifest.status });
      } catch (error) {
        const workflowError = error as WorkflowError;
        reply.code(400);
        return reply.send(errorBody(workflowError.code ?? "INVALID_CONFIGURATION", workflowError.message));
      }
    });

    app.get<{ Params: { artifactId: string } }>("/v1/artifacts/:artifactId", async (request, reply) => {
      if (!(await authRoutes(request, reply as never))) {
        return reply;
      }
      try {
        const resolved = await this.options.runtime.resolveArtifact(request.params.artifactId);
        const info = await stat(resolved.path);
        reply.header("Content-Type", resolved.contentType);
        reply.header("Content-Length", info.size);
        reply.header("Cache-Control", "no-store");
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.send(await readFile(resolved.path));
      } catch (error) {
        const workflowError = error as WorkflowError;
        reply.code(404);
        return reply.send(errorBody(workflowError.code ?? "ARTIFACT_NOT_FOUND", workflowError.message));
      }
    });

    // Offline fallback: serve the built UI from the same loopback origin.
    if (this.options.uiDistDir) {
      app.get("*", async (request, reply) => {
        const pathname = new URL(request.url, "http://localhost").pathname;
        const safe = pathname.split("/").filter(Boolean).join("/");
        const candidate = join(this.options.uiDistDir as string, safe);
        try {
          const info = await stat(candidate);
          if (info.isFile()) {
            reply.header("Content-Type", this.contentTypeFor(candidate));
            return reply.send(await readFile(candidate));
          }
        } catch {
          // Fall through to index.html.
        }
        reply.header("Content-Type", "text/html; charset=utf-8");
        return reply.send(await readFile(join(this.options.uiDistDir as string, "index.html")));
      });
    }
  }

  async start(): Promise<number> {
    await this.app.register(cors, {
      origin: (origin, callback) => {
        callback(null, this.allowedOrigin(origin));
      },
      methods: ["GET", "POST", "PUT", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: false,
    });
    await this.app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });
    this.registerRoutes();
    try {
      await this.app.listen({ host: this.options.host, port: this.options.port });
    } catch (error) {
      this.options.log(`Unable to listen on ${this.options.host}:${this.options.port}: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
    this.options.log(`API listening on http://${this.options.host}:${this.options.port}`);
    return this.options.port;
  }

  async stop(): Promise<void> {
    await this.app.close();
  }
}

export const DEFAULT_HOST = "127.0.0.1";
export { DEFAULT_SERVICE_PORT };
export type { RunDetailResponse, RunSummary };
