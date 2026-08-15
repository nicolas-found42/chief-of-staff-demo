#!/usr/bin/env node
import { DEFAULT_SERVICE_PORT, SERVICE_VERSION, PROTOCOL_VERSION, type LlmMode } from "@chief-of-staff/contracts";
import { Workspace, WorkflowError, type Logger } from "@chief-of-staff/workflow";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiServer, DEFAULT_HOST } from "./api/server.js";
import { ServiceRuntime } from "./runtime.js";

interface CliOptions {
  workspace: string;
  port: number;
  mode: LlmMode;
  developer: boolean;
  fixturesDir?: string;
  uiDistDir?: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    workspace: resolve(process.cwd(), "local-workspace"),
    port: DEFAULT_SERVICE_PORT,
    mode: "live",
    developer: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--workspace") {
      options.workspace = resolve(argv[++i]);
    } else if (arg === "--port") {
      options.port = Number(argv[++i]);
    } else if (arg === "--mode") {
      options.mode = argv[++i] as LlmMode;
    } else if (arg === "--fixtures") {
      options.fixturesDir = resolve(argv[++i]);
    } else if (arg === "--dev") {
      options.developer = true;
    }
  }
  if (options.mode !== "live" && options.mode !== "record" && options.mode !== "replay") {
    throw new Error(`Unknown mode: ${options.mode}`);
  }
  if ((options.mode === "record" || options.mode === "replay") && !options.developer) {
    throw new Error(`Mode "${options.mode}" requires --dev (developer mode)`);
  }
  return options;
}

const logger: Logger = {
  info: (message) => console.log(`[service] ${message}`),
  warn: (message) => console.warn(`[service] ${message}`),
  error: (message) => console.error(`[service] ${message}`),
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const workspace = new Workspace(options.workspace);
  const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

  const runtime = new ServiceRuntime({
    workspace,
    repoRoot,
    mode: options.mode,
    fixturesDir: options.fixturesDir,
    developerMode: options.developer,
    logger,
  });

  try {
    await runtime.start();
  } catch (error) {
    if (error instanceof WorkflowError && error.code === "WORKFLOW_DEFINITION_CHANGED") {
      logger.error(error.message);
      process.exit(1);
    }
    logger.warn(
      `Service started with configuration issues: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Offline fallback UI: serve the built web app when present.
  const webDist = join(repoRoot, "apps", "web", "dist");
  const uiDistDir = existsSync(webDist) ? webDist : undefined;

  const server = new ApiServer({
    runtime,
    host: DEFAULT_HOST,
    port: options.port,
    uiDistDir,
    log: (message) => logger.warn(message),
  });

  const code = runtime.issuePairingCode();
  console.log("");
  console.log("Chief of Staff local service");
  console.log(`  version:         ${SERVICE_VERSION} (protocol ${PROTOCOL_VERSION})`);
  console.log(`  workspace:       ${options.workspace}`);
  console.log(`  UI:              http://127.0.0.1:${options.port}/`);
  console.log(`  mode:            ${options.mode}`);
  console.log(`  pairing code:    ${code}  (valid 5 minutes)`);
  console.log("");

  try {
    await server.start();
  } catch (error) {
    logger.error(error instanceof Error ? error.message : String(error));
    await runtime.stop();
    process.exit(1);
  }

  const shutdown = async (): Promise<void> => {
    await server.stop().catch(() => undefined);
    await runtime.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
