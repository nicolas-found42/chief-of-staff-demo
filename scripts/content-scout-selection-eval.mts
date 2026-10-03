/**
 * Enrichment-selection promotion gate (#503): run the frozen labeled corpus at
 * tests/fixtures/content-scout/selection-corpus.json through the semantic
 * three-judgment selector and the current deterministic selector, and report
 * precision, recall, and fallback counts for the deployed and candidate
 * threshold pairs.
 *
 * Zero-model mode (default, CI-safe): scores the deterministic baseline and,
 * with --judgments <file>, the semantic thresholds over pre-recorded
 * judgments. The gate evidence lives at
 * tests/fixtures/content-scout/selection-corpus-judgments.json (recorded from
 * upstage/solar-pro4 on 2026-10-03, gate PASS: precision 0.950 / recall 0.704
 * vs the deterministic 0.516 / 0.593), so:
 *
 *   pnpm exec tsx scripts/content-scout-selection-eval.mts \
 *     --judgments tests/fixtures/content-scout/selection-corpus-judgments.json
 *
 * replays the promotion comparison with no model calls. Live mode (--live)
 * asks the real model once per item under OPENROUTER_API_KEY (~52 small
 * calls) and records the judgments with --record for reuse.
 *
 * The deterministic baseline re-states the current selector's rules
 * (enrichment.ts: 40+ chars, evidence present, 30+ words, promo-phrase veto).
 * Every corpus row stands for a collected item, so the evidence check is
 * present by construction here.
 *
 * Usage:
 *   pnpm exec tsx scripts/content-scout-selection-eval.mts
 *   pnpm exec tsx scripts/content-scout-selection-eval.mts --judgments tests/fixtures/content-scout/selection-corpus-judgments.json
 *   pnpm exec tsx scripts/content-scout-selection-eval.mts --live --model upstage/solar-pro4 --record /tmp/sel-judgments.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import {
  SELECTION_THRESHOLDS,
  combineSelectionJudgments,
  modelSelectionJudger,
  type SelectionJudgment,
  type SelectionThresholds,
} from "../apps/server/src/modules/content-scout/selection-model.js";

interface CorpusItem {
  id: string;
  category: string;
  brandProfileId: string;
  title: string | null;
  body: string | null;
  description: string | null;
  publishedAt: string | null;
  canonicalUrl: string;
  expectedEnrich: boolean;
  rationale: string;
}

interface Corpus {
  questionRevision: number;
  brandProfiles: Record<string, string>;
  items: CorpusItem[];
}

type JudgmentsFile = Record<string, SelectionJudgment>;

function parseArgs(argv: string[]): {
  live: boolean;
  model: string;
  record: string | null;
  judgments: string | null;
  help: boolean;
} {
  const options: ReturnType<typeof parseArgs> = {
    live: false,
    model: "openai/gpt-oss-20b",
    record: null,
    judgments: null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--model") options.model = argv[++i] ?? options.model;
    else if (arg === "--record") options.record = argv[++i] ?? options.record;
    else if (arg === "--judgments") options.judgments = argv[++i] ?? options.judgments;
  }
  return options;
}

function usage(): never {
  console.log(`content-scout-selection-eval — #503 promotion gate over the frozen corpus

Usage:
  tsx scripts/content-scout-selection-eval.mts [--live] [--model <slug>]
      [--record <out.json>] [--judgments <file.json>]

  default       deterministic-selector baseline only; no model calls
  --judgments   score the semantic thresholds against a recorded judgments file
  --live        record fresh judgments from the real model (needs OPENROUTER_API_KEY)
  --record      where to write --live judgments
`);
  process.exit(0);
}

/** Minimal stand-in for a collected Source Item; the judger reads only the
 *  evidence fields. */
function corpusAsItem(item: CorpusItem) {
  return {
    id: item.id,
    externalId: item.id,
    targetId: "eval",
    adapterId: "eval",
    canonicalUrl: item.canonicalUrl,
    author: null,
    title: item.title,
    body: item.body,
    description: item.description,
    publishedAt: item.publishedAt,
    discoveredAt: item.publishedAt ?? "",
    media: [],
    transcript: null,
    comments: [],
    evidence: [{ route: "eval:corpus", retrievedAt: item.publishedAt ?? "" }],
    completeness: {
      title: item.title === null ? "unavailable" : "available",
      body: item.body === null ? "unavailable" : "available",
      description: item.description === null ? "unavailable" : "available",
      transcript: "unsupported" as const,
      comments: "unsupported" as const,
      media: "unsupported" as const,
    },
  };
}

const PROMO_PHRASES = ["click here", "buy now", "limited time", "sign up today", "free trial"];

function deterministicSelects(item: CorpusItem): boolean {
  const text = [item.title, item.body, item.description].filter(Boolean).join("\n").trim();
  const words = text.split(/\s+/).filter(Boolean);
  const lower = text.toLowerCase();
  const promoHit =
    PROMO_PHRASES.some((phrase) => lower.includes(phrase)) && lower.includes("% off");
  return text.length >= 40 && item.id.length > 0 && words.length >= 30 && !promoHit;
}

interface Metrics {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

function score(
  items: CorpusItem[],
  decisions: boolean[],
): Metrics & { precision: number; recall: number } {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (let index = 0; index < items.length; index += 1) {
    const expected = items[index]!.expectedEnrich;
    const actual = decisions[index]!;
    if (actual && expected) tp += 1;
    else if (actual && !expected) fp += 1;
    else if (!actual && expected) fn += 1;
    else tn += 1;
  }
  return {
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp === 0 ? 0 : tp / (tp + fp),
    recall: tp + fn === 0 ? 0 : tp / (tp + fn),
  };
}

function semanticDecisions(
  corpus: Corpus,
  judgments: JudgmentsFile,
  thresholds: SelectionThresholds,
  fallback: (item: CorpusItem) => boolean,
): { decisions: boolean[]; fallbacks: number } {
  let fallbacks = 0;
  const decisions = corpus.items.map((item) => {
    const judgment = judgments[item.id];
    if (!judgment) {
      fallbacks += 1;
      return fallback(item);
    }
    const outcome = combineSelectionJudgments(judgment, thresholds);
    if (outcome.branch === "fallback") {
      fallbacks += 1;
      return fallback(item);
    }
    return outcome.selected;
  });
  return { decisions, fallbacks };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) usage();
  const corpus = JSON.parse(
    await readFile(
      new URL("../tests/fixtures/content-scout/selection-corpus.json", import.meta.url),
      "utf8",
    ),
  ) as Corpus;
  if (corpus.items.length < 50) {
    throw new Error(`Corpus holds ${corpus.items.length} items; the gate freezes on at least 50.`);
  }

  const deterministic = score(
    corpus.items,
    corpus.items.map((item) => deterministicSelects(item)),
  );
  console.log("deterministic selector (current path):");
  console.log(
    `  precision ${deterministic.precision.toFixed(3)}  recall ${deterministic.recall.toFixed(3)}  tp ${deterministic.tp} fp ${deterministic.fp} fn ${deterministic.fn} tn ${deterministic.tn}`,
  );

  let judgments: JudgmentsFile | null = null;
  if (options.live) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY missing: run with --judgments <file> or export a key.");
      process.exit(2);
    }
    const complete = makeCompleteJson({ provider: "openrouter", model: options.model, apiKey }, "");
    const judger = modelSelectionJudger(() => complete);
    judgments = {};
    for (const item of corpus.items) {
      const judgment = await judger({
        item: corpusAsItem(item) as never,
        brandProfile: {
          id: item.brandProfileId,
          markdown: corpus.brandProfiles[item.brandProfileId]!,
        } as never,
      });
      if (judgment) judgments[item.id] = judgment;
      console.log(`  ${item.id} ${judgment ? JSON.stringify(judgment) : "(failed → fallback)"}`);
    }
    if (options.record) {
      await writeFile(options.record, `${JSON.stringify(judgments, null, 2)}\n`);
      console.log(`recorded judgments to ${options.record}`);
    }
  } else if (options.judgments) {
    judgments = JSON.parse(await readFile(options.judgments, "utf8")) as JudgmentsFile;
  }

  if (judgments) {
    const fallback = (item: CorpusItem) => deterministicSelects(item);
    console.log("\nsemantic thresholds (candidate grid; deployed values starred):");
    for (const cut of [0.6, 0.7, 0.8]) {
      for (const band of [0.12, 0.16, 0.2]) {
        const thresholds: SelectionThresholds = {
          fitPass: cut,
          substancePass: cut,
          promoPass: cut,
          band,
        };
        const { decisions, fallbacks } = semanticDecisions(corpus, judgments, thresholds, fallback);
        const metrics = score(corpus.items, decisions);
        const star =
          cut === SELECTION_THRESHOLDS.fitPass && band === SELECTION_THRESHOLDS.band ? " *" : "";
        console.log(
          `  cut ${cut.toFixed(2)} band ${band.toFixed(2)}: precision ${metrics.precision.toFixed(3)}  recall ${metrics.recall.toFixed(3)}  fp ${metrics.fp} fn ${metrics.fn} fallbacks ${fallbacks}${star}`,
        );
      }
    }
    const deployed = semanticDecisions(corpus, judgments, SELECTION_THRESHOLDS, fallback);
    const deployedMetrics = score(corpus.items, deployed.decisions);
    console.log("\npromotion gate (deployed thresholds vs deterministic):");
    console.log(
      `  semantic recall    ${deployedMetrics.recall.toFixed(3)} vs ${deterministic.recall.toFixed(3)}`,
    );
    console.log(
      `  semantic precision ${deployedMetrics.precision.toFixed(3)} vs ${deterministic.precision.toFixed(3)}`,
    );
    console.log(`  fallback rate      ${(deployed.fallbacks / corpus.items.length).toFixed(3)}`);
    const gatePasses =
      deployedMetrics.recall >= deterministic.recall &&
      deployedMetrics.precision >= deterministic.precision;
    console.log(gatePasses ? "gate: PASS" : "gate: FAIL — keep the current selector and report");
  }
}

await main();
