/**
 * Static server for the built UI: serves apps/web/dist at the root AND at a
 * GitHub Pages-style project subpath, mirroring relative-base builds.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DIST = join(REPO_ROOT, "apps", "web", "dist");
const SUBPATH = "/chief-of-staff-local";

function contentType(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".ico") return "image/x-icon";
  return "application/octet-stream";
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let pathname = url.pathname;
  let stripped = pathname;
  if (pathname === SUBPATH || pathname.startsWith(`${SUBPATH}/`)) {
    stripped = pathname.slice(SUBPATH.length) || "/";
  }
  const safe = stripped.split("/").filter((segment) => segment && segment !== "..").join("/");
  let candidate = join(DIST, safe);
  if (safe === "") {
    candidate = join(DIST, "index.html");
  }
  try {
    const info = await stat(candidate);
    if (!info.isFile()) {
      candidate = join(DIST, "index.html");
    }
  } catch {
    candidate = join(DIST, "index.html");
  }
  const body = await readFile(candidate);
  res.writeHead(200, { "Content-Type": contentType(candidate) });
  res.end(body);
});

server.listen(4581, "127.0.0.1", () => {
  console.log("STATIC UI READY http://127.0.0.1:4581");
});
