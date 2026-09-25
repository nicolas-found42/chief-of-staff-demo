import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  InstallationProviderId,
  InstallationStatus,
  ProviderId,
} from "@chief-of-staff-demo/shared";

/** The only environment names this installation boundary owns. */
const INSTALLATION_PROVIDER_ENV: Record<InstallationProviderId, string> = {
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
};

const INSTALLATION_ENV_NAMES = [
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  ...Object.values(INSTALLATION_PROVIDER_ENV),
] as const;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Load the optional, gitignored installation file without overriding values
 * already supplied by the process environment. The parser intentionally knows
 * only the installation names: an unrelated `.env` entry is not copied into the
 * process, and no value is ever logged.
 */
function loadInstallationEnvironment(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return;
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch {
    return;
  }
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice(7).trim() : line;
    const separator = withoutExport.indexOf("=");
    if (separator <= 0) continue;
    const name = withoutExport.slice(0, separator).trim();
    if (!INSTALLATION_ENV_NAMES.includes(name)) continue;
    if (process.env[name] === undefined)
      process.env[name] = unquote(withoutExport.slice(separator + 1));
  }
}

function configured(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** The content-free installation projection exposed by configuration reads. */
export function installationStatus(): InstallationStatus {
  loadInstallationEnvironment();
  const providerKeys = Object.fromEntries(
    Object.entries(INSTALLATION_PROVIDER_ENV).map(([provider, name]) => [
      provider,
      { state: configured(process.env[name]) ? "configured" : "missing" },
    ]),
  ) as InstallationStatus["providerKeys"];
  return {
    googleClient: {
      state:
        configured(process.env.GOOGLE_CLIENT_ID) && configured(process.env.GOOGLE_CLIENT_SECRET)
          ? "configured"
          : "missing",
    },
    providerKeys,
    ollama: { state: "not-required" },
  };
}

export function installationProviderKey(provider: ProviderId): string {
  if (provider === "ollama" || provider === "mock") return "";
  loadInstallationEnvironment();
  return process.env[INSTALLATION_PROVIDER_ENV[provider as InstallationProviderId]] ?? "";
}

export function installationGoogleClient(): { clientId: string; clientSecret: string } {
  loadInstallationEnvironment();
  return {
    clientId: process.env.GOOGLE_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
  };
}
