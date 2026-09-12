/**
 * Private Meeting Wizard validation campaigns (#363, MWR-017/019/020/021/022/057).
 *
 * Freezes a campaign/slot manifest before any dispatch — code and diff
 * revision, image, source context, model/route/binding/grant, prompt and
 * schema fingerprints, corpus revision, budgets and cold roots — then runs
 * exactly the planned slots that hold no terminal outcome yet through the
 * application's extraction path, charging every call to the existing budget
 * ledger and recording it in the timeline store. The report counts what the
 * frozen plan holds: nearest-rank p95 over successful processing durations,
 * cost per success (undefined at zero successes), zero-denominator semantic
 * categories as not applicable, and Golden scores kept apart from privately
 * retained blind human judgments.
 *
 * Ordinary output never carries a case id or produced content: a slot line
 * names its position, model, arm and outcome shape only.
 *
 * Usage: tsx scripts/run-validation-campaign.mts [options]   (see --help)
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT,
  type CampaignFreezeFacts,
  type CampaignManifest,
  type CampaignModelRoute,
  type CampaignProtocol,
  type ProviderId,
  type SourceLifecycleGrant,
} from "../packages/shared/src/index.js";
import { ModelAdmissionService } from "../apps/server/src/llm/admission.js";
import { ModelBudgetLedger } from "../apps/server/src/llm/budget.js";
import { createSourceLifecycleGrant } from "../apps/server/src/llm/grants.js";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import { ModelTimelineStore } from "../apps/server/src/llm/timeline.js";
import { buildDebriefMessages } from "../apps/server/src/modules/meeting-debrief/extraction.js";
import type { DebriefIdentityReview } from "../apps/server/src/modules/meeting-debrief/deps.js";
import {
  loadCampaignCorpus,
  type CampaignCorpusCase,
} from "../apps/server/src/validation/corpus.js";
import { readSourceLifecycleGrant } from "../apps/server/src/validation/grant-file.js";
import {
  assertManifestMatchesPlan,
  canonicalJson,
  freezeCampaignManifest,
  readCampaignManifest,
  writeCampaignManifest,
} from "../apps/server/src/validation/manifest.js";
import { planCampaignSlots } from "../apps/server/src/validation/plan.js";
import { renderSlotProgress } from "../apps/server/src/validation/progress.js";
import {
  buildCampaignReport,
  createExtractionSlotExecutor,
  mockModelPriceEvidence,
  runValidationCampaign,
  syntheticTranscriptRecord,
} from "../apps/server/src/validation/run.js";
import { renderCampaignReport } from "../apps/server/src/validation/stats.js";

/** The extractor strategy label the recorded runs carry. */
const STRATEGY = "candidate-accounting-v12";
const DEFAULT_CORPUS = "tests/fixtures/debrief-golden";
const DEFAULT_MOCK_RESULT = "tests/fixtures/mock-result.json";
/** The three-development-model set recorded for the review (#349). */
const DEFAULT_MODELS = [
  "deepseek/deepseek-v4.1-flash",
  "nvidia/nemotron-3.5-lightning",
  "nex-agi/nex-n2.5-mini:free",
];
const EMPTY_IDENTITY: DebriefIdentityReview = { mentions: [], decisions: [], organizations: [] };
const PROVIDER_IDS: readonly ProviderId[] = [
  "openai",
  "anthropic",
  "openrouter",
  "gemini",
  "ollama",
  "mock",
];

export interface CampaignCliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CampaignCliOptions {
  forwardOutput?: boolean;
}

const HELP = `Private Meeting Wizard validation campaign

  pnpm exec tsx scripts/run-validation-campaign.mts [options]

Freezes a campaign manifest before dispatch, then runs every planned slot that
holds no terminal outcome. Requires a provider; the mock provider spends
nothing and contacts nothing.

Options
  --campaign-id <id>      Stable campaign identifier (default: <protocol>-<date>).
  --protocol <name>       baseline | comparison | final | brief (default: baseline).
  --corpus <dir>          Frozen Golden corpus directory (default: ${DEFAULT_CORPUS}).
  --incidents <dir>       Cold incident transcripts, one case per file.
  --brief-cases <dir>     Brief transcripts, one case per file.
  --models <m1,m2,...>    Model ids (default: the three development models).
  --provider <name>       Provider id (default: openrouter; use mock for a dry run).
  --mock-result <path>    Mock reply file (default: ${DEFAULT_MOCK_RESULT}).
  --grant <path>          Frozen source-lifecycle grant; required for a live provider.
  --out <dir>             Private campaign record root (default: <tmp>/debrief-campaign/<id>).
  --budget-root <dir>     Durable ledger/timeline root (default: <out>/budget).
  --campaign-allowance <usd>
                          Cumulative USD ceiling the campaign ledger is created
                          with. Required for a live provider; the owner states
                          it, nothing defaults it. An existing ledger keeps its
                          own allowance. A mock run defaults to 0.
  --concurrency <n>       Slots in flight (default: 4).
  --allow-live            Required before a non-mock provider may dispatch.
  --no-recovery           End a slot at its first failed call or rejected
                          answer: no binding ladder, no backoff, no repair
                          round. The outcome names the stage and the slot's
                          error file carries the specific complaint.
  --plan-only             Freeze the manifest and print the plan; no dispatch.
  --report <dir>          Rebuild and print one campaign's report; no dispatch.
  --close                 Close the campaign: unrecorded slots become missing with a reason.
  --reason <text>         Reason recorded with --close.
  --help                  This text.

Live dispatch requires --allow-live, an authorized grant and the provider's
credentials; it spends real budget. Case ids and produced content stay out of
ordinary output.`;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function runValidationCampaignCli(
  rawArgs: string[],
  options?: CampaignCliOptions,
): Promise<CampaignCliResult> {
  let stdout = "";
  let stderr = "";
  const writeStdout = (text: string) => {
    stdout += text;
    if (options?.forwardOutput) process.stdout.write(text);
  };
  const writeStderr = (text: string) => {
    stderr += text;
    if (options?.forwardOutput) process.stderr.write(text);
  };
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const args = [...rawArgs];
  const arg = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} needs a value.`);
    return value;
  };
  const flag = (name: string): boolean => args.includes(`--${name}`);

  try {
    if (flag("help")) {
      writeStdout(`${HELP}\n`);
      return { status: 0, stdout, stderr };
    }

    if (flag("report")) {
      const dir = resolve(repoRoot, arg("report") ?? "");
      // Rebuilds report.json from the frozen record; no dispatch, no spend.
      writeStdout(renderCampaignReport(buildCampaignReport(dir, new Date().toISOString())));
      return { status: 0, stdout, stderr };
    }

    const protocol = (arg("protocol") ?? "baseline") as CampaignProtocol;
    if (!["baseline", "comparison", "final", "brief"].includes(protocol)) {
      throw new Error(`--protocol must be baseline, comparison, final or brief, got ${protocol}.`);
    }
    const providerName = arg("provider") ?? "openrouter";
    if (!PROVIDER_IDS.includes(providerName as ProviderId)) {
      throw new Error(`--provider must be one of ${PROVIDER_IDS.join(", ")}, got ${providerName}.`);
    }
    const provider = providerName as ProviderId;
    const models = (arg("models") ?? DEFAULT_MODELS.join(","))
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
    if (models.length === 0) throw new Error("--models must name at least one model.");
    const incidents = arg("incidents");
    const briefCases = arg("brief-cases");
    const corpus = loadCampaignCorpus({
      goldenDir: resolve(repoRoot, arg("corpus") ?? DEFAULT_CORPUS),
      ...(incidents !== undefined ? { incidentDir: resolve(repoRoot, incidents) } : {}),
      ...(briefCases !== undefined ? { briefDir: resolve(repoRoot, briefCases) } : {}),
    });
    if (corpus.cases.length === 0) throw new Error("The corpus holds no cases to plan.");
    if (protocol !== "brief" && corpus.revision.goldenCaseIds.length === 0) {
      throw new Error("The corpus holds no Golden cases; every non-Brief protocol plans them.");
    }

    const campaignId = arg("campaign-id") ?? `${protocol}-${new Date().toISOString().slice(0, 10)}`;
    const out = resolve(repoRoot, arg("out") ?? join(tmpdir(), "debrief-campaign", campaignId));
    const coldRoot = join(out, "slots");
    const budgetRoot = resolve(repoRoot, arg("budget-root") ?? join(out, "budget"));
    const concurrency = Number(arg("concurrency") ?? "4");
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error(`--concurrency must be a positive integer, got ${arg("concurrency")}.`);
    }

    /* The owner states the campaign ceiling (#363): the former USD 100
       ledger default was an agent recommendation the owner never approved,
       so a live campaign refuses to start without an explicit figure. */
    const allowanceArg = arg("campaign-allowance");
    if (provider !== "mock" && allowanceArg === undefined) {
      throw new Error(
        "A live provider needs --campaign-allowance <usd>, the owner's cumulative ceiling for this campaign.",
      );
    }
    const campaignAllowanceDollars = Number(allowanceArg ?? "0");
    if (!Number.isFinite(campaignAllowanceDollars) || campaignAllowanceDollars < 0) {
      throw new Error(
        `--campaign-allowance must be a non-negative USD amount, got ${allowanceArg}.`,
      );
    }
    let grant: SourceLifecycleGrant | null = null;
    if (provider !== "mock") {
      const grantPath = arg("grant");
      if (grantPath === undefined) {
        throw new Error(
          "A live provider needs --grant, a private source-lifecycle grant for this campaign.",
        );
      }
      grant = readSourceLifecycleGrant(resolve(repoRoot, grantPath));
      if (!flag("allow-live")) {
        throw new Error(
          `--provider ${provider} would spend real budget; pass --allow-live with an authorized grant.`,
        );
      }
      if (provider === "openrouter" && !process.env.OPENROUTER_API_KEY) {
        throw new Error("OPENROUTER_API_KEY is missing.");
      }
    }

    mkdirSync(budgetRoot, { recursive: true });
    /* A mock run contacts nothing and is billed nothing: give its models
       zero-cost evidence so the dry run cannot consume the campaign allowance
       the durable ledger tracks. */
    const ledger = new ModelBudgetLedger(budgetRoot, {
      campaignAllowanceDollars,
      ...(provider === "mock" ? { priceEvidenceTable: mockModelPriceEvidence(models) } : {}),
    });
    const campaign = ledger.getCampaignSnapshot();
    const routeFor = (model: string): CampaignModelRoute =>
      grant === null
        ? { model, route: "mock-local", binding: "model-default", grantId: "mock-local" }
        : {
            model,
            route: `openrouter/${grant.routePolicy.zdrRequired ? "zdr-required" : "non-zdr-exception"}`,
            binding: "model-default",
            grantId: grant.id,
          };
    const modelRoutes = models.map(routeFor);
    const slots = planCampaignSlots({
      campaignId,
      protocol,
      corpus: corpus.revision,
      models: modelRoutes,
      coldRoot,
    });

    const codeRevision = gitText(repoRoot, ["rev-parse", "HEAD"]) ?? "unknown";
    const status = gitText(repoRoot, ["status", "--porcelain", "-uall"]) ?? "";
    const diff = gitText(repoRoot, ["diff", "HEAD"]) ?? "";
    const sample = buildDebriefMessages(
      syntheticTranscriptRecord({
        fileName: "campaign-fingerprint.md",
        text: "campaign prompt fingerprint sample",
        ingestedAt: "1970-01-01T00:00:00.000Z",
      }),
      EMPTY_IDENTITY,
    );
    const freeze: CampaignFreezeFacts = {
      codeRevision,
      diffHash: status.trim() === "" && diff.trim() === "" ? "clean" : sha256(`${status}\n${diff}`),
      imageDigest: process.env.CAMPAIGN_IMAGE_DIGEST ?? "local-process",
      sourceContextHash: sha256(
        canonicalJson({ identity: EMPTY_IDENTITY, record: "eval-synthetic" }),
      ),
      promptHash: sha256(sample.system),
      schemaHash: sha256(JSON.stringify(sample.schema)),
      validatorVersion: STRATEGY,
      corpus: corpus.revision,
      models: modelRoutes,
      campaignBudgetDollars: campaign.allowedDollars,
      operationBudgetDollars: DEBRIEF_OPERATION_BUDGET_DOLLARS_DEFAULT,
      coldRoot,
    };

    const manifestPath = join(out, "manifest.json");
    let manifest: CampaignManifest;
    if (existsSync(manifestPath)) {
      manifest = readCampaignManifest(out);
      assertManifestMatchesPlan(manifest, { protocol, freeze, slots });
      writeStdout(`reusing the frozen manifest at ${manifestPath}\n`);
    } else {
      manifest = freezeCampaignManifest({
        campaignId,
        protocol,
        createdAt: new Date().toISOString(),
        freeze,
        slots,
      });
      writeCampaignManifest(out, manifest);
      writeStdout(`frozen manifest at ${manifestPath}\n`);
    }

    writeStdout(renderPlan(manifest));
    if (flag("plan-only")) {
      return { status: 0, stdout, stderr };
    }

    const cases = new Map<string, CampaignCorpusCase>();
    for (const entry of corpus.cases) {
      if (cases.has(entry.caseId)) {
        throw new Error(`Case id ${entry.caseId} appears twice in the frozen corpus revision.`);
      }
      cases.set(entry.caseId, entry);
    }
    const admission = new ModelAdmissionService({});
    const timelineStore = new ModelTimelineStore(budgetRoot);
    const completeFor = new Map(
      models.map((model) => [
        model,
        makeCompleteJson(
          { provider, model, apiKey: process.env.OPENROUTER_API_KEY ?? "" },
          resolve(repoRoot, arg("mock-result") ?? DEFAULT_MOCK_RESULT),
          { admission, budgetLedger: ledger, timelineStore },
        ),
      ]),
    );
    const executor = createExtractionSlotExecutor({
      ...(flag("no-recovery") ? { recovery: "none" as const } : {}),
      transcriptFor: (caseId) => {
        const entry = cases.get(caseId);
        if (entry === undefined) throw new Error(`Unknown case ${caseId} in the frozen plan.`);
        return { path: entry.transcriptPath, file: entry.transcriptFile };
      },
      completeFor: (model) => {
        const complete = completeFor.get(model);
        if (complete === undefined) throw new Error(`No completion seam for model ${model}.`);
        return complete;
      },
      identity: EMPTY_IDENTITY,
      grantFor: (model) =>
        grant ??
        createSourceLifecycleGrant({
          sourceId: `campaign:${campaignId}`,
          purpose: "validation-campaign",
          grantedBy: "campaign-harness-mock",
          model,
        }),
      strategy: STRATEGY,
      ledger,
      timeline: timelineStore,
    });

    const slotPosition = new Map(manifest.slots.map((slot, index) => [slot.slotId, index]));
    const { report } = await runValidationCampaign({
      campaignDir: out,
      executor,
      concurrency,
      ...(flag("close")
        ? {
            closeIncomplete: {
              reason:
                arg("reason") ?? "The operator closed the campaign before every planned slot ran.",
            },
          }
        : {}),
      onSlotSettled: ({ slot, outcome }) => {
        writeStdout(
          `${renderSlotProgress({
            index: slotPosition.get(slot.slotId) ?? 0,
            total: manifest.slots.length,
            kind: slot.kind,
            model: slot.model,
            arm: slot.arm,
            repetition: slot.repetition,
            status: outcome.status,
            chargedAttempts: outcome.chargedAttempts,
            processingMs: outcome.processingMs,
            costDollars: outcome.costDollars,
            failure: outcome.failure ?? null,
          })}\n`,
        );
      },
    });
    writeStdout(renderCampaignReport(report));
    writeStdout(`report: ${join(out, "report.json")}\n`);
    return { status: report.completion.successes === report.planned ? 0 : 1, stdout, stderr };
  } catch (error) {
    writeStderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    return { status: 1, stdout, stderr };
  }
}

function gitText(repoRoot: string, args: string[]): string | null {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** The plan as ordinary output: positions and identifiers, never case text. */
function renderPlan(manifest: CampaignManifest): string {
  const lines: string[] = [];
  const byKind = { golden: 0, incident: 0, brief: 0 };
  for (const slot of manifest.slots) byKind[slot.kind] += 1;
  lines.push(
    `campaign ${manifest.campaignId} (${manifest.protocol}, frozen ${manifest.createdAt})`,
  );
  lines.push(
    `planned ${manifest.slots.length} slots: golden ${byKind.golden}, incident ${byKind.incident}, brief ${byKind.brief} — corpus revision ${manifest.freeze.corpus.revision.slice(0, 12)}`,
  );
  const perModel = new Map<string, number>();
  for (const slot of manifest.slots) {
    perModel.set(slot.model, (perModel.get(slot.model) ?? 0) + 1);
  }
  for (const [model, count] of perModel) lines.push(`  ${model}: ${count} slot(s)`);
  lines.push(
    `budgets: campaign $${manifest.freeze.campaignBudgetDollars.toFixed(2)}, operation $${manifest.freeze.operationBudgetDollars.toFixed(2)}`,
  );
  return `${lines.join("\n")}\n`;
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
  const result = await runValidationCampaignCli(process.argv.slice(2), { forwardOutput: true });
  process.exit(result.status);
}
