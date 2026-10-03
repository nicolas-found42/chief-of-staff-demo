/**
 * Citation-support shadow promotion gate (#504): run the frozen labeled pair
 * corpus at tests/fixtures/person-profile/citation-support-pairs.json through
 * the question revision and compare the model verdicts against the hand
 * labels — with the deterministic qualifier's publication outcome recorded
 * beside each pair, because shadow agreement with it is what the gate
 * measures.
 *
 * Zero-model mode (default): replays a recorded verdicts file. Live mode
 * (--live) asks the model once per pair under OPENROUTER_API_KEY (~55 small
 * calls) and records with --record.
 *
 * Usage:
 *   pnpm exec tsx scripts/person-citation-support-eval.mts [--live] [--model <slug>] [--record <out.json>] [--verdicts <file>]
 */
import { readFile, writeFile } from "node:fs/promises";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import {
  CITATION_SUPPORT_QUESTION_REVISION,
  modelCitationSupportJudger,
} from "../apps/server/src/person-profile/citation-support.js";
import { qualifyClaimEvidence } from "../apps/server/src/person-profile/claim-evidence.js";

interface CorpusPair {
  id: string;
  category: string;
  expected: "supported" | "insufficient" | "contradicted";
  claimStatement: string;
  passage: string;
  attribution: "third-party" | "self-report";
  publishedStatus: "supported" | "claimed";
}

interface Corpus {
  pairs: CorpusPair[];
}

type Verdicts = Record<string, { support: string; confidence: number }>;

function parseArgs(argv: string[]) {
  const options = {
    live: false,
    model: "upstage/solar-pro4",
    record: null as string | null,
    verdicts: null as string | null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--model") options.model = argv[++i] ?? options.model;
    else if (arg === "--record") options.record = argv[++i] ?? options.record;
    else if (arg === "--verdicts") options.verdicts = argv[++i] ?? options.verdicts;
  }
  return options;
}

function pairAsClaim(pair: CorpusPair, sourceId: string) {
  return {
    id: `gate-${pair.id}`,
    section: "career" as const,
    statement: pair.claimStatement,
    status: pair.publishedStatus,
    nature: "statement" as const,
    matchConfidence: "high" as const,
    effectiveFrom: null,
    effectiveTo: null,
    citations: [{ sourceId, quote: pair.passage }],
    supports: [],
    supersedes: [],
    changeReason: null,
  };
}

function pairAsSource(pair: CorpusPair, sourceId: string) {
  return {
    schemaVersion: 1,
    id: sourceId,
    url: "https://gate.example/source",
    title: pair.claimStatement.slice(0, 60),
    author: null,
    publishedAt: null,
    retrievedAt: "2026-09-01T00:00:00.000Z",
    text: `${pair.passage}`,
    hash: "gate-source-hash",
    attribution: pair.attribution,
    sourceClass: "profile",
    capturedAt: "2026-09-01T00:00:00.000Z",
  } as never;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      "person-citation-support-eval — #504 shadow promotion gate over the frozen pair corpus",
    );
    process.exit(0);
  }
  const corpusUrl = new URL(
    "../tests/fixtures/person-profile/citation-support-pairs.json",
    import.meta.url,
  );
  const corpus = JSON.parse(await readFile(corpusUrl, "utf8")) as Corpus;
  if (corpus.pairs.length < 50) {
    throw new Error(`Corpus holds ${corpus.pairs.length} pairs; the gate freezes on at least 50.`);
  }

  let verdicts: Verdicts;
  if (options.live) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY missing; replay a recorded file or export a key.");
      process.exit(2);
    }
    const judger = modelCitationSupportJudger(() =>
      makeCompleteJson({ provider: "openrouter", model: options.model, apiKey }, ""),
    );
    verdicts = {};
    for (const pair of corpus.pairs) {
      const verdict = await judger({
        claim: pairAsClaim(pair, `gate-src-${pair.id}`),
        source: pairAsSource(pair, `gate-src-${pair.id}`),
      });
      if (verdict) verdicts[pair.id] = verdict;
      console.log(`  ${pair.id} ${verdict ? verdict.support : "(failed)"}`);
    }
    if (options.record) {
      await writeFile(options.record, `${JSON.stringify(verdicts, null, 2)}\n`);
      console.log(`recorded verdicts to ${options.record}`);
    }
  } else if (options.verdicts) {
    verdicts = JSON.parse(await readFile(options.verdicts, "utf8")) as Verdicts;
  } else {
    verdicts = JSON.parse(
      await readFile(
        new URL(
          "../tests/fixtures/person-profile/citation-support-pairs-verdicts.json",
          import.meta.url,
        ),
        "utf8",
      ),
    ) as Verdicts;
  }

  /* Agreement metrics against hand labels, with the deterministic qualifier's
     outcome beside them: the shadow comparison the gate records. */
  let agree = 0;
  let disagreements = 0;
  const mismatchLines: string[] = [];
  let qualifierMismatch = 0;
  for (const pair of corpus.pairs) {
    const verdict = verdicts[pair.id];
    if (!verdict) {
      mismatchLines.push(`${pair.id} missing verdict`);
      disagreements += 1;
      continue;
    }
    if (verdict.support === pair.expected) agree += 1;
    else {
      disagreements += 1;
      mismatchLines.push(
        `${pair.id} ${pair.category}: expected ${pair.expected}, got ${verdict.support}`,
      );
    }
    /* The deterministic qualifier's publication outcome for this pair. */
    const qualified = qualifyClaimEvidence(
      pairAsClaim(pair, `gate-src-${pair.id}`),
      pairAsSource(pair, `gate-src-${pair.id}`),
    );
    const qualifierStatus = qualified.status;
    const qualifierMatchesLabel =
      (pair.expected === "supported" && qualifierStatus === "supported") ||
      (pair.expected !== "supported" && qualifierStatus !== "supported");
    if (!qualifierMatchesLabel) qualifierMismatch += 1;
  }
  console.log(`pairs: ${corpus.pairs.length}`);
  console.log(
    `semantic agreement with labels: ${agree} (${(agree / corpus.pairs.length).toFixed(3)})`,
  );
  console.log(`deterministic qualifier disagreements with labels: ${qualifierMismatch}`);
  for (const line of mismatchLines.slice(0, 20)) console.log(`  ${line}`);
  console.log(`questionRevision: ${CITATION_SUPPORT_QUESTION_REVISION}`);
  const hardNegativesClean = mismatchLines.some((line) => line.includes("negation")) === false;
  console.log(`negation pairs all correct: ${hardNegativesClean}`);
  console.log(
    hardNegativesClean && agree / corpus.pairs.length >= 0.8
      ? "gate: PASS (shadow comparison supports the ADR-0099 amendment discussion)"
      : "gate: INCOMPLETE — record results; behavior changes only after an ADR-0099 amendment",
  );
}

await main();
