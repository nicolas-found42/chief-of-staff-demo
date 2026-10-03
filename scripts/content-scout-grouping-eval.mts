/**
 * Story-grouping promotion gate (#502): run the frozen labeled pair corpus at
 * tests/fixtures/content-scout/grouping-pairs.json through the same-story
 * question and compare model verdicts against the hand labels, then report
 * the metrics the promotion gate needs (false merges, same-story recall,
 * ambiguity handling) for the deployed threshold.
 *
 * Zero-model mode (default, CI-safe): scores a recorded verdicts file — the
 * gate evidence lives at tests/fixtures/content-scout/grouping-pairs-verdicts.json.
 * Live mode (--live) asks the real model once per pair under
 * OPENROUTER_API_KEY (~57 small calls) and records verdicts with --record.
 *
 * Usage:
 *   pnpm exec tsx scripts/content-scout-grouping-eval.mts
 *   pnpm exec tsx scripts/content-scout-grouping-eval.mts --live --model upstage/solar-pro4 --record /tmp/verdicts.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { makeCompleteJson } from "../apps/server/src/llm/providers.js";
import {
  GROUPING_AMBIGUITY_CAP,
  GROUPING_PAIR_BUDGET,
  GROUPING_QUESTION_REVISION,
  GROUPING_VERDICT_THRESHOLD,
  modelStoryPairJudger,
  sameStoryVerdict,
  type PairVerdict,
} from "../apps/server/src/modules/content-scout/grouping-model.js";

interface CorpusPair {
  id: string;
  category: string;
  expected: "same" | "different" | "ambiguous";
  left: {
    title: string | null;
    body: string;
    description: string | null;
    publishedAt: string;
    canonicalUrl: string;
  };
  right: {
    title: string | null;
    body: string;
    description: string | null;
    publishedAt: string;
    canonicalUrl: string;
  };
}

type Recorded = Record<string, PairVerdict>;

function parseArgs(argv: string[]) {
  const options = {
    live: false,
    model: "upstage/solar-pro4",
    record: null as string | null,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) break;
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--live") options.live = true;
    else if (arg === "--model") options.model = argv[++i] ?? options.model;
    else if (arg === "--record") options.record = argv[++i] ?? options.record;
  }
  return options;
}

function corpusPairAsItem(pair: CorpusPair["left"], id: string) {
  return {
    id,
    externalId: id,
    targetId: "eval",
    adapterId: "eval",
    canonicalUrl: pair.canonicalUrl,
    author: null,
    title: pair.title,
    body: pair.body,
    description: pair.description,
    publishedAt: pair.publishedAt,
    discoveredAt: pair.publishedAt,
    media: [],
    transcript: null,
    comments: [],
    evidence: [{ route: "eval:corpus", retrievedAt: pair.publishedAt }],
    completeness: {
      title: pair.title === null ? "unavailable" : "available",
      body: "available",
      description: pair.description === null ? "unavailable" : "available",
      transcript: "unsupported" as const,
      comments: "unsupported" as const,
      media: "unsupported" as const,
    },
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("content-scout-grouping-eval — #502 promotion gate over the frozen pair corpus");
    process.exit(0);
  }
  const corpusRoot = new URL("../tests/fixtures/content-scout/", import.meta.url);
  const corpus = JSON.parse(await readFile(new URL("grouping-pairs.json", corpusRoot), "utf8")) as {
    pairs: CorpusPair[];
  };
  if (corpus.pairs.length < 50) {
    throw new Error(`Corpus holds ${corpus.pairs.length} pairs; the gate freezes on at least 50.`);
  }

  let verdicts: Recorded;
  if (options.live) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      console.error("OPENROUTER_API_KEY missing; use the recorded verdicts or export a key.");
      process.exit(2);
    }
    const judger = modelStoryPairJudger(() =>
      makeCompleteJson({ provider: "openrouter", model: options.model, apiKey }, ""),
    );
    verdicts = {};
    for (const [index, pair] of corpus.pairs.entries()) {
      const verdict = await judger({
        left: corpusPairAsItem(pair.left, `l${index}`) as never,
        right: corpusPairAsItem(pair.right, `r${index}`) as never,
      });
      if (verdict) verdicts[pair.id] = verdict;
      console.log(`  ${pair.id} ${verdict ? JSON.stringify(verdict) : "(failed)"}`);
    }
    if (options.record) {
      await writeFile(options.record, `${JSON.stringify(verdicts, null, 2)}\n`);
      console.log(`recorded verdicts to ${options.record}`);
    }
  } else {
    verdicts = JSON.parse(
      await readFile(new URL("grouping-pairs-verdicts.json", corpusRoot), "utf8"),
    ) as Recorded;
  }

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const misses: string[] = [];
  for (const pair of corpus.pairs) {
    const verdict = verdicts[pair.id];
    const merges = sameStoryVerdict(verdict, GROUPING_QUESTION_REVISION);
    if (merges && pair.expected === "same") truePositives += 1;
    else if (merges && pair.expected !== "same") {
      falsePositives += 1;
      misses.push(`${pair.id} FALSE MERGE (expected ${pair.expected})`);
    } else if (!merges && pair.expected === "same") {
      falseNegatives += 1;
      misses.push(`${pair.id} missed (expected same)`);
    }
  }
  const sameCount = corpus.pairs.filter((pair) => pair.expected === "same").length;
  console.log(`pairs: ${corpus.pairs.length}  same-labeled: ${sameCount}`);
  console.log(
    `true merges: ${truePositives}  false merges: ${falsePositives}  missed merges: ${falseNegatives}`,
  );
  for (const miss of misses) console.log(`  ${miss}`);
  console.log(
    `threshold: ${GROUPING_VERDICT_THRESHOLD}  ambiguityCap: ${GROUPING_AMBIGUITY_CAP}  budget: ${GROUPING_PAIR_BUDGET}  questionRevision: ${GROUPING_QUESTION_REVISION}`,
  );
  const gatePasses = falsePositives === 0 && truePositives > sameCount / 2;
  console.log(gatePasses ? "gate: PASS" : "gate: FAIL — keep deterministic grouping and report");
  if (!gatePasses) process.exit(1);
}

await main();
