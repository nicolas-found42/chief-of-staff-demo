/**
 * Spec #418 T8 — the frozen live-probe manifest and its runner.
 *
 * This module has two halves, deliberately separable:
 *
 * 1. Pure, deterministic functions (`buildProbeCells`, `freezeManifest`,
 *    `assertLiveDispatchAuthorized`, `sanitizeAttempt`, `evaluateAdmissibility`)
 *    that need no network access and are covered by
 *    `tests/src/unit/person-extraction-probes.test.ts`.
 * 2. `runManifest`/`main`, which dispatch real wire calls through the exact
 *    production `makeCompleteJson` seam (never a copy of it) against T8a's
 *    fictional boundary fixtures, and write a sanitized, committed report.
 *
 * Authorization on record (spec #418, ticket T8): live probes against
 * `inception/mercury-2.5` on the `openrouter` route only. ADR-0091 requires
 * the exact model string in every call and every recorded provenance line —
 * `assertLiveDispatchAuthorized` fails closed if it does not match exactly.
 * This runner dispatches ONLY the finite cells declared below; it is not
 * authorized to run `scripts/person-research-benchmark.mts`'s corpus
 * acceptance comparison (see the manifest's `notAuthorized` field and the
 * disposition report this script's output feeds).
 *
 * Nothing here writes prompt text, document text, citation quotes, or raw
 * model answers into the committed report — only shape facts (binding,
 * finish reason, populated/empty fields, usage counts, validation outcome).
 * Full per-attempt detail, including the fixture text each cell sent and the
 * raw model reply, is written to the gitignored `artifacts/person-benchmark/`
 * directory for local inspection only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { ZodTypeAny } from "zod/v3";

import {
  ExtractionSchema,
  type Extraction,
} from "../apps/server/src/person-profile/extraction-parts.js";
import {
  EXTRACTION_SYSTEM,
  EXTRACTION_PREFERRED_MIN_THROUGHPUT,
} from "../apps/server/src/person-profile/research.js";
import { makeCompleteJson, type CompletionRequest } from "../apps/server/src/llm/providers.js";
import { modelBoundaryDiagnostic } from "../apps/server/src/llm/failure.js";
import {
  MODEL_SMALL_REQUEST_TIMEOUT_MS,
  type ModelAttemptEvent,
  type ProviderId,
} from "@chief-of-staff-demo/shared";
import * as boundaryFixtures from "../tests/src/modules/person-research-extraction-boundary-fixtures.js";

// zod-to-json-schema is a dependency of apps/server, not the repo root;
// resolve it the same way scripts/debug/extraction-live-audit.mts does
// (issue precedent), rather than adding a root dependency for one hash.
const { zodToJsonSchema } = createRequire(new URL("../apps/server/package.json", import.meta.url))(
  "zod-to-json-schema",
) as { zodToJsonSchema: (schema: ZodTypeAny) => unknown };

/** ADR-0091: exact string, no `-preview`, no alias, in every call and every recorded line. */
export const EXTRACTION_MODEL = "inception/mercury-2.5" as const;
export const EXTRACTION_PROVIDER = "openrouter" as const;

/** Mercury's only declared route (mercury-capabilities-evidence.md, captured 2026-09-15). */
export const MERCURY_MAX_COMPLETION_TOKENS = 65536;

export const PROBE_MANIFEST_VERSION = 1;

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

// ---------------------------------------------------------------------------
// Fixtures (T8a) this manifest is allowed to dispatch. Fictional, non-sensitive
// (tests/src/modules/person-research-extraction-boundary-fixtures.ts).
// ---------------------------------------------------------------------------

export const FIXTURE_KEYS = [
  "denseMultiClaim",
  "sparseIdentityOnly",
  "noRelevantFacts",
  "duplicateLocalIdsPartA",
  "wrongSubjectDocument",
] as const;
export type FixtureKey = (typeof FIXTURE_KEYS)[number];

function fixtureDocumentText(key: FixtureKey): string {
  switch (key) {
    case "denseMultiClaim":
      return boundaryFixtures.denseMultiClaim.documentText;
    case "sparseIdentityOnly":
      return boundaryFixtures.sparseIdentityOnly.documentText;
    case "noRelevantFacts":
      return boundaryFixtures.noRelevantFacts.documentText;
    case "duplicateLocalIdsPartA":
      return boundaryFixtures.duplicateLocalIds.partA.documentText;
    case "wrongSubjectDocument":
      return boundaryFixtures.wrongSubjectDocument;
  }
}

/**
 * The extraction request body exactly as `research.ts` builds `partUser`
 * (`research.ts:989-1005`), over one fictional fixture document. All fixtures
 * share the same fictional subject identity (Dana Okonkwo / Vellum Robotics)
 * except `noRelevantFacts`, which is a document that mentions neither — the
 * point of that fixture.
 */
function fixtureUser(key: FixtureKey): string {
  return JSON.stringify({
    researchScope: "Full historical and current research.",
    person: {
      name: "Dana Okonkwo",
      emails: [],
      employer: "Vellum Robotics",
      profileUrls: [],
    },
    document: {
      url: "https://example-probe.invalid/fixture",
      title: "T8a boundary fixture",
      text: fixtureDocumentText(key),
      sourceOffset: 0,
      part: "1/1",
      completeness: "complete",
      format: "text",
      provenance: "fixture",
      visibility: "public",
      outboundUrls: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Cells (spec #418 §3): the existing full request; a small-shape control;
// explicit-budget full; budget-plus-effort; full with schema instructions;
// the eligible forced-tool recovery; plus the repaired-full qualification set.
// Every field not named as a cell's own experimental variable is held
// constant at the "existing full request" baseline (T4's pre-T8 production
// shape minus the placeholder ceiling: forced_tool_call preferred, temperature
// 0, compact wire names, the extraction preferred-throughput floor).
// ---------------------------------------------------------------------------

export const PROBE_CELL_IDS = [
  "existing-full",
  "small-shape-control",
  "explicit-budget-16384",
  "explicit-budget-65536",
  "budget-plus-effort",
  "schema-instructions-only",
  "repaired-full",
  "forced-tool-recovery",
] as const;
export type ProbeCellId = (typeof PROBE_CELL_IDS)[number];

/** Options this manifest may vary per cell, layered onto the shared baseline below. */
interface CellRequestOptions {
  preferredBinding?: "forced_tool_call";
  outputTokenCeiling?: number;
  reasoningEffort?: string;
  describeResultShape?: boolean;
}

export interface ProbeCellSpec {
  id: ProbeCellId;
  /** Spec §3's lever this cell characterizes, and what it holds constant vs. varies. */
  description: string;
  /** The one declared experimental variable this cell isolates. */
  variable: string;
  fixtures: readonly FixtureKey[];
  repetitions: number;
  options: CellRequestOptions;
}

/**
 * `selectedCeiling` is the candidate under test for cells that need one
 * chosen (repaired-full, forced-tool-recovery) — NOT yet the production
 * decision; that is recorded separately once live results are in (see
 * `docs/research/person-extraction-probes-2026-09-15.json`'s `selection`).
 */
export function buildProbeCells(selectedCeiling: number): ProbeCellSpec[] {
  return [
    {
      id: "existing-full",
      description:
        "The unrepaired production request (spec §3 characterization): full shape, forced_tool_call preferred, no explicit output ceiling, no describeResultShape — reproduces the incident's own request shape.",
      variable: "none (baseline)",
      fixtures: ["denseMultiClaim"],
      repetitions: 2,
      options: { preferredBinding: "forced_tool_call" },
    },
    {
      id: "small-shape-control",
      description:
        "The same unrepaired shape over a small-output fixture, establishing the provider is reachable and the failure (if any) is proportional to output size, not blanket unavailability.",
      variable: "fixture size (document + expected answer), same request options as existing-full",
      fixtures: ["sparseIdentityOnly"],
      repetitions: 2,
      options: { preferredBinding: "forced_tool_call" },
    },
    {
      id: "explicit-budget-16384",
      description:
        "Explicit-budget full request at a modest candidate ceiling, isolating the output-ceiling lever alone (spec §2, §3).",
      variable: "outputTokenCeiling = 16384",
      fixtures: ["denseMultiClaim"],
      repetitions: 2,
      options: { preferredBinding: "forced_tool_call", outputTokenCeiling: 16384 },
    },
    {
      id: "explicit-budget-65536",
      description:
        "Explicit-budget full request at Mercury's declared completion ceiling (mercury-capabilities-evidence.md), isolating the output-ceiling lever alone at its maximum candidate value.",
      variable: "outputTokenCeiling = 65536",
      fixtures: ["denseMultiClaim"],
      repetitions: 2,
      options: {
        preferredBinding: "forced_tool_call",
        outputTokenCeiling: MERCURY_MAX_COMPLETION_TOKENS,
      },
    },
    {
      id: "budget-plus-effort",
      description:
        "Explicit ceiling plus reasoning effort dropped to the advertised `none` (capability evidence item 5), isolating whether reducing invisible reasoning consumption — not only raising the ceiling — is needed.",
      variable: "outputTokenCeiling = 65536 AND reasoningEffort = none",
      fixtures: ["denseMultiClaim"],
      repetitions: 2,
      options: {
        preferredBinding: "forced_tool_call",
        outputTokenCeiling: MERCURY_MAX_COMPLETION_TOKENS,
        reasoningEffort: "none",
      },
    },
    {
      id: "schema-instructions-only",
      description:
        "describeResultShape alone, at the unrepaired ceiling/effort baseline, isolating lever 3.8's own effect from the budget levers above.",
      variable: "describeResultShape = true",
      fixtures: ["denseMultiClaim"],
      repetitions: 2,
      options: { preferredBinding: "forced_tool_call", describeResultShape: true },
    },
    {
      id: "repaired-full",
      description:
        "All first-line fixes combined (the actual post-T1/T4 production shape) across the qualification set: dense, sparse, legitimately-empty, duplicate-id-part and wrong-subject fixtures. Determines whether the repaired full strategy is qualified (spec §3).",
      variable: "fixture identity, all other options fixed at the repaired combination",
      fixtures: FIXTURE_KEYS,
      repetitions: 1,
      options: {
        preferredBinding: "forced_tool_call",
        outputTokenCeiling: selectedCeiling,
        reasoningEffort: "low",
        describeResultShape: true,
      },
    },
    {
      id: "forced-tool-recovery",
      description:
        "Deliberately prefers response_format (overriding extraction's own forced_tool_call preference, for this probe cell only) on the repaired combination, to observe whether an empty response_format answer steps down to forced_tool_call exactly once (spec §4, T7's emptyEverywhereForcedToolCallRecoverable rung) and to settle which binding/field the incident actually hit.",
      variable: "preferredBinding = response_format (all other options match repaired-full)",
      fixtures: ["denseMultiClaim"],
      repetitions: 2,
      options: {
        preferredBinding: undefined,
        outputTokenCeiling: selectedCeiling,
        reasoningEffort: "low",
        describeResultShape: true,
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Freezing
// ---------------------------------------------------------------------------

export interface ProbeManifest {
  manifestVersion: number;
  model: string;
  provider: ProviderId;
  /** What this manifest's authorization covers, and what it explicitly does not (owner record). */
  authorization: {
    spendCeiling: string;
    routePermission: string;
    notAuthorized: string;
  };
  policyVersion: number;
  schemaHash: string;
  fixtureHashes: Record<FixtureKey, string>;
  cells: ProbeCellSpec[];
  codeVersion: string | null;
  frozenAt: string;
  /** Hash over everything above except `frozenAt`/`codeVersion`: a changed experiment gets a new identity. */
  manifestHash: string;
}

function gitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

export function freezeManifest(options: {
  selectedCeiling: number;
  policyVersion: number;
  now?: () => Date;
  codeVersion?: string | null;
}): ProbeManifest {
  const cells = buildProbeCells(options.selectedCeiling);
  const schemaHash = sha256(JSON.stringify(zodToJsonSchema(ExtractionSchema)));
  const fixtureHashes = Object.fromEntries(
    FIXTURE_KEYS.map((key) => [key, sha256(fixtureDocumentText(key))]),
  ) as Record<FixtureKey, string>;
  const identity = {
    manifestVersion: PROBE_MANIFEST_VERSION,
    model: EXTRACTION_MODEL,
    provider: EXTRACTION_PROVIDER,
    policyVersion: options.policyVersion,
    schemaHash,
    fixtureHashes,
    cells,
  };
  const manifestHash = sha256(JSON.stringify(identity));
  return {
    ...identity,
    authorization: {
      spendCeiling:
        "Owner-authorized live probes only, no numeric ceiling given; kept small and bounded to this manifest's declared cells (a few dozen small Mercury calls, cents at $0.04/M input, $0.15/M output).",
      routePermission: "openrouter, inception/mercury-2.5 only, exact ADR-0091 string.",
      notAuthorized:
        "A full Person Research Benchmark corpus acceptance run (scripts/person-research-benchmark.mts) is explicitly NOT authorized by this ticket; see the disposition report for its cost/requirements estimate.",
    },
    codeVersion: options.codeVersion ?? gitSha(),
    frozenAt: (options.now ?? (() => new Date()))().toISOString(),
    manifestHash,
  };
}

// ---------------------------------------------------------------------------
// Authorization gate
// ---------------------------------------------------------------------------

export class LiveDispatchNotAuthorizedError extends Error {}

/**
 * Fails closed before any wire dispatch. Deterministically testable without
 * network: every condition here is checked from inputs the caller supplies,
 * never from a live response.
 */
export function assertLiveDispatchAuthorized(options: {
  manifest: Pick<ProbeManifest, "model" | "provider">;
  hasApiKey: boolean;
  confirmed: boolean;
}): void {
  if (options.manifest.provider !== EXTRACTION_PROVIDER) {
    throw new LiveDispatchNotAuthorizedError(
      `Route not authorized: ${options.manifest.provider}. Only "${EXTRACTION_PROVIDER}" is authorized.`,
    );
  }
  if (options.manifest.model !== EXTRACTION_MODEL) {
    throw new LiveDispatchNotAuthorizedError(
      `Model identity not authorized (ADR-0091 requires the exact string): got "${options.manifest.model}", expected "${EXTRACTION_MODEL}".`,
    );
  }
  if (!options.hasApiKey) {
    throw new LiveDispatchNotAuthorizedError(
      "OPENROUTER_API_KEY is not set; refusing live dispatch.",
    );
  }
  if (!options.confirmed) {
    throw new LiveDispatchNotAuthorizedError(
      "Live dispatch requires explicit --confirm-live-spend; refusing to spend without it.",
    );
  }
}

// ---------------------------------------------------------------------------
// Sanitization and admissibility
// ---------------------------------------------------------------------------

/** Shape-only per-attempt record. No prompt, document, quote or raw answer text. */
export interface SanitizedAttempt {
  attempt: number;
  binding: ModelAttemptEvent["binding"];
  outcome: ModelAttemptEvent["outcome"];
  provider: ModelAttemptEvent["provider"];
  model: string;
  reasoningEffort?: string;
  requestedReasoningEffort?: string;
  systemFingerprint?: string;
  usage?: ModelAttemptEvent["usage"];
  diagnostic: ModelAttemptEvent["diagnostic"];
  observedUpstreamRoute: string;
}

export function sanitizeAttempt(
  event: ModelAttemptEvent,
  observedUpstreamRoute: string,
): SanitizedAttempt {
  return {
    attempt: event.attempt,
    binding: event.binding,
    outcome: event.outcome,
    provider: event.provider,
    model: event.model,
    ...(event.reasoningEffort !== undefined ? { reasoningEffort: event.reasoningEffort } : {}),
    ...(event.requestedReasoningEffort !== undefined
      ? { requestedReasoningEffort: event.requestedReasoningEffort }
      : {}),
    ...(event.systemFingerprint !== undefined
      ? { systemFingerprint: event.systemFingerprint }
      : {}),
    ...(event.usage !== undefined ? { usage: event.usage } : {}),
    diagnostic: event.diagnostic,
    observedUpstreamRoute,
  };
}

export interface AdmissibilityResult {
  /** A legitimate validated (possibly empty) Extraction is admissible; an HTTP-200 empty answer is not. */
  admissible: boolean;
  reason: string;
  emptyExtraction?: boolean;
  validationIssueCount?: number;
}

/** Pure: never dispatches, never reads request/response text beyond the parsed answer already in hand. */
export function evaluateAdmissibility(rawAnswer: unknown): AdmissibilityResult {
  const parsed = ExtractionSchema.safeParse(rawAnswer);
  if (!parsed.success) {
    return {
      admissible: false,
      reason: "Model answer did not validate against ExtractionSchema.",
      validationIssueCount: parsed.error.issues.length,
    };
  }
  const extraction: Extraction = parsed.data;
  const isEmpty =
    extraction.fullName === null &&
    extraction.employer === null &&
    extraction.author === null &&
    extraction.publishedAt === null &&
    extraction.claims.length === 0 &&
    extraction.works.length === 0 &&
    extraction.expertise.length === 0 &&
    extraction.connections.length === 0 &&
    extraction.sections.length === 0;
  return {
    admissible: true,
    reason: isEmpty
      ? "Schema-valid Extraction with no supported facts: a legitimate validated empty extraction, admissible."
      : "Schema-valid Extraction with supported facts.",
    emptyExtraction: isEmpty,
  };
}

// ---------------------------------------------------------------------------
// Live dispatch
// ---------------------------------------------------------------------------

export interface SanitizedCellRepetition {
  fixture: FixtureKey;
  repetition: number;
  wallClockMs: number;
  attempts: SanitizedAttempt[];
  finalOutcome: "admitted" | "boundary-failure";
  admissibility?: AdmissibilityResult;
  /** Present only when finalOutcome is "boundary-failure"; the classified fact, not payload text. */
  failureDiagnostic?: ModelAttemptEvent["diagnostic"];
}

export interface SanitizedCellResult {
  id: ProbeCellId;
  description: string;
  variable: string;
  repetitions: SanitizedCellRepetition[];
}

type Complete = (request: CompletionRequest) => Promise<unknown>;

/**
 * Wraps `fetch` for the duration of one attempt to read OpenRouter's
 * streamed per-chunk `provider` field — the OBSERVED Upstream Route, which
 * this ticket requires recording rather than assuming. Restores the original
 * `fetch` afterward regardless of outcome.
 */
async function withObservedRoute<T>(
  work: () => Promise<T>,
): Promise<{ result: T; routes: string[] }> {
  const routes: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await realFetch(input, init);
    const url = input instanceof Request ? input.url : input.toString();
    if (!url.endsWith("/chat/completions") || !response.body) return response;
    let buffer = "";
    const decoder = new TextDecoder();
    const body = response.body.pipeThrough(
      new TransformStream({
        transform(chunk: Uint8Array, controller) {
          buffer += decoder.decode(chunk, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
            try {
              const event = JSON.parse(line.slice(5)) as { provider?: string };
              if (event.provider && !routes.includes(event.provider)) routes.push(event.provider);
            } catch {
              /* Non-JSON SSE event carries no provider metadata. */
            }
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  try {
    const result = await work();
    return { result, routes };
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function runOneRepetition(
  complete: Complete,
  spec: ProbeCellSpec,
  fixture: FixtureKey,
  repetition: number,
): Promise<SanitizedCellRepetition> {
  const events: ModelAttemptEvent[] = [];
  const began = performance.now();
  try {
    const { result: raw, routes } = await withObservedRoute(() =>
      complete({
        system: EXTRACTION_SYSTEM,
        user: fixtureUser(fixture),
        schema: ExtractionSchema,
        temperature: 0,
        compactWireNames: true,
        preferredMinThroughput: EXTRACTION_PREFERRED_MIN_THROUGHPUT,
        absoluteCeilingMs: MODEL_SMALL_REQUEST_TIMEOUT_MS,
        retry: { onAttempt: (event) => events.push(event) },
        ...spec.options,
      }),
    );
    const route = routes.length > 0 ? routes.join(",") : "unknown";
    return {
      fixture,
      repetition,
      wallClockMs: Math.round(performance.now() - began),
      attempts: events.map((event) => sanitizeAttempt(event, route)),
      finalOutcome: "admitted",
      admissibility: evaluateAdmissibility(raw),
    };
  } catch (error) {
    const diagnostic = modelBoundaryDiagnostic(error);
    return {
      fixture,
      repetition,
      wallClockMs: Math.round(performance.now() - began),
      attempts: events.map((event) => sanitizeAttempt(event, "unknown")),
      finalOutcome: "boundary-failure",
      failureDiagnostic: diagnostic,
    };
  }
}

export async function runManifest(
  manifest: ProbeManifest,
  complete: Complete,
): Promise<SanitizedCellResult[]> {
  const results: SanitizedCellResult[] = [];
  for (const spec of manifest.cells) {
    const repetitions: SanitizedCellRepetition[] = [];
    for (const fixture of spec.fixtures) {
      for (let repetition = 1; repetition <= spec.repetitions; repetition += 1) {
        repetitions.push(await runOneRepetition(complete, spec, fixture, repetition));
      }
    }
    results.push({
      id: spec.id,
      description: spec.description,
      variable: spec.variable,
      repetitions,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const OUT_PATH = "docs/research/person-extraction-probes-2026-09-15.json";
const RAW_ARTIFACT_DIR = "artifacts/person-benchmark";

export async function main(argv: string[]): Promise<number> {
  const confirmed = argv.includes("--confirm-live-spend");
  const apiKey = process.env.OPENROUTER_API_KEY;
  const manifest = freezeManifest({
    selectedCeiling: MERCURY_MAX_COMPLETION_TOKENS,
    policyVersion: 1,
  });
  try {
    assertLiveDispatchAuthorized({ manifest, hasApiKey: Boolean(apiKey), confirmed });
  } catch (error) {
    if (error instanceof LiveDispatchNotAuthorizedError) {
      process.stderr.write(`${error.message}\n`);
      return 1;
    }
    throw error;
  }
  const complete = makeCompleteJson(
    { provider: EXTRACTION_PROVIDER, model: EXTRACTION_MODEL, apiKey: apiKey! },
    "",
  );
  const results = await runManifest(manifest, complete);
  mkdirSync(RAW_ARTIFACT_DIR, { recursive: true });
  writeFileSync(
    resolve(RAW_ARTIFACT_DIR, `extraction-probes-${manifest.manifestHash.slice(0, 16)}.json`),
    JSON.stringify({ manifest, results }, null, 2),
  );
  mkdirSync("docs/research", { recursive: true });
  const committedPath = resolve(OUT_PATH);
  const suffix = existsSync(committedPath) ? `-${manifest.manifestHash.slice(0, 8)}` : "";
  writeFileSync(
    suffix ? committedPath.replace(/\.json$/, `${suffix}.json`) : committedPath,
    `${JSON.stringify({ manifest, results }, null, 2)}\n`,
  );
  process.stdout.write(`Wrote ${results.length} cell(s) of results.\n`);
  return 0;
}

const isMain = (): boolean => {
  if (!process.argv[1]) return false;
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1]);
  } catch {
    return false;
  }
};

if (isMain()) {
  const status = await main(process.argv.slice(2));
  process.exit(status);
}
