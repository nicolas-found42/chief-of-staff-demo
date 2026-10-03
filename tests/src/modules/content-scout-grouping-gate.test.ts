import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GROUPING_QUESTION_REVISION,
  applyPairVerdicts,
  candidatePairs,
  sameStoryVerdict,
  type PairVerdict,
} from "../../../apps/server/src/modules/content-scout/grouping-model.js";
import type { SourceItem } from "@chief-of-staff-demo/shared";

interface CorpusPair {
  id: string;
  category: string;
  expected: "same" | "different" | "ambiguous";
  left: { title: string | null; body: string };
  right: { title: string | null; body: string };
}

interface Corpus {
  pairs: CorpusPair[];
}

interface RecordedVerdicts {
  [pairId: string]: PairVerdict;
}

const corpusRoot = join(import.meta.dirname, "../../../tests/fixtures/content-scout");
const corpus = JSON.parse(readFileSync(join(corpusRoot, "grouping-pairs.json"), "utf8")) as Corpus;
const recorded = JSON.parse(
  readFileSync(join(corpusRoot, "grouping-pairs-verdicts.json"), "utf8"),
) as RecordedVerdicts;

function verdictFor(expected: CorpusPair["expected"]): PairVerdict {
  switch (expected) {
    case "same":
      return { same: 0.95, different: 0.02, ambiguous: 0.03 };
    case "different":
      return { same: 0.02, different: 0.95, ambiguous: 0.03 };
    case "ambiguous":
      return { same: 0.45, different: 0.25, ambiguous: 0.3 };
  }
}

describe("the grouping promotion gate over the frozen corpus (#502)", () => {
  it("has at least 50 reviewed pairs and a verdict for each", () => {
    expect(corpus.pairs.length).toBeGreaterThanOrEqual(50);
    for (const pair of corpus.pairs) {
      expect(recorded[pair.id], `missing verdict for ${pair.id}`).toBeTruthy();
    }
  });

  it("decides exactly the confident same verdicts and keeps ambiguous separate", () => {
    let truePositives = 0;
    let falsePositives = 0;
    let falseNegatives = 0;
    for (const pair of corpus.pairs) {
      const merges = sameStoryVerdict(recorded[pair.id], GROUPING_QUESTION_REVISION);
      if (merges && pair.expected === "same") truePositives += 1;
      else if (merges && pair.expected !== "same") falsePositives += 1;
      else if (!merges && pair.expected === "same") falseNegatives += 1;
    }
    /* The promotion gate: no false merge of a labeled different pair, and
       same-story recall beats the old heuristic's measured 3/8 on its own
       probe corpus. Asserted on the frozen comparison, not tuned to it. */
    expect(falsePositives).toBe(0);
    expect(truePositives).toBeGreaterThan(
      corpus.pairs.filter((p) => p.expected === "same").length / 2,
    );
  });

  it("builds identical partitions from any item permutation (clique first-fit)", () => {
    const items = corpus.pairs.slice(0, 12).flatMap((pair, index) => [
      { id: `l${index}`, title: pair.left.title, body: pair.left.body },
      { id: `r${index}`, title: pair.right.title, body: pair.right.body },
    ]) as unknown as SourceItem[];
    const verdicts = new Map<string, PairVerdict>();
    for (const [index, pair] of corpus.pairs.slice(0, 12).entries()) {
      verdicts.set(`l${index}|r${index}`, verdictFor(pair.expected));
    }
    const pairs: [string, string][] = corpus.pairs
      .slice(0, 12)
      .map((_, index) => [`l${index}`, `r${index}`] as [string, string]);
    const forward = applyPairVerdicts(items, pairs, verdicts, GROUPING_QUESTION_REVISION);
    const shuffled = applyPairVerdicts(
      [...items].reverse(),
      pairs,
      verdicts,
      GROUPING_QUESTION_REVISION,
    );
    const normalize = (partition: Set<string>[]) =>
      partition
        .map((group) => [...group].sort())
        .sort((left, right) => left.join("|").localeCompare(right.join("|")));
    expect(normalize(shuffled)).toEqual(normalize(forward));
  });

  it("orders candidate pairs deterministically for a fixed item set", () => {
    const items = corpus.pairs.slice(0, 10).flatMap((pair, index) => [
      { id: `a${index}`, title: pair.left.title, body: pair.left.body },
      { id: `b${index}`, title: pair.right.title, body: pair.right.body },
    ]) as unknown as SourceItem[];
    expect(candidatePairs(items, { budget: 15 })).toEqual(
      candidatePairs([...items], { budget: 15 }),
    );
  });
});
