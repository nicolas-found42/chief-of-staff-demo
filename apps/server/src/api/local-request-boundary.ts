import type { FastifyInstance } from "fastify";

/** Loopback binding alone does not stop browser writes or DNS rebinding (ADR-0001). */
export function registerLocalRequestBoundary(app: FastifyInstance, port: number): void {
  const origins = new Set(
    ["localhost", "127.0.0.1", "[::1]"].map((host) => new URL(`http://${host}:${port}`).origin),
  );
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host;
    if (!host || !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i.test(host)) {
      return reply.code(403).send({
        error: "untrusted-host",
        message: "Open this local app using localhost or its loopback address.",
      });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      return reply.code(403).send({
        error: "untrusted-origin",
        message:
          "This request came from outside the local app. Open the app directly and try again.",
      });
    }

    // Fastify decodes route segments; a raw URL check would miss /%61pi/tasks.
    const pathname = request.routeOptions.url;
    const site = request.headers["sec-fetch-site"];
    // Native clients have no browser metadata. Browser API requests must be same-origin;
    // another local port is same-site, and can still submit a malicious form.
    if (
      pathname?.startsWith("/api/") &&
      site !== undefined &&
      site !== "same-origin" &&
      site !== "none"
    ) {
      const callbackNavigation =
        request.method === "GET" &&
        pathname === "/api/google/callback" &&
        request.headers["sec-fetch-mode"] === "navigate" &&
        request.headers["sec-fetch-dest"] === "document";
      if (!callbackNavigation) {
        return reply.code(403).send({
          error: "untrusted-origin",
          message: "Open the local app directly to access its API.",
        });
      }
    }
  });
}
