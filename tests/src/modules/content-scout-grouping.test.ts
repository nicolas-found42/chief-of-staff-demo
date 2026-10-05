import { describe, expect, it } from "vitest";
import {
  GROUPING_PAIR_BUDGET,
  GROUPING_QUESTION_REVISION,
  GROUPING_VERDICT_THRESHOLD,
  applyPairVerdicts,
  candidatePairs,
  sameStoryVerdict,
} from "../../../apps/server/src/modules/content-scout/grouping-model.js";
import type { SourceItem } from "@chief-of-staff-demo/shared";

function item(id: string, title: string, body = title, storyKey?: string): SourceItem {
  return {
    id,
    externalId: id,
    targetId: "t",
    adapterId: "a",
    canonicalUrl: `https://example.com/${id}`,
    author: null,
    title,
    body,
    description: null,
    publishedAt: "2026-09-20T10:00:00.000Z",
    discoveredAt: "2026-09-20T10:00:00.000Z",
    media: [],
    transcript: null,
    comments: [],
    evidence: [{ route: "fixture", retrievedAt: "2026-09-20T10:00:00.000Z" }],
    completeness: {
      title: "available",
      body: "available",
      description: "unavailable",
      transcript: "unavailable",
      comments: "unavailable",
      media: "unavailable",
    },
    ...(storyKey ? { storyKey } : {}),
  };
}

describe("candidatePairs", () => {
  it("produces each unordered pair once in deterministic order", () => {
    const items = [item("a", "Atlas launch"), item("b", "Atlas ships"), item("c", "Beacon ships")];
    const pairs = candidatePairs(items, { budget: 100 });
    expect(pairs).toEqual([
      ["a", "b"],
      ["b", "c"],
      ["a", "c"],
    ]);
  });

  it("spends the budget on the most token-sharing pairs first", () => {
    const alpha = item(
      "alpha",
      "Vellum Robotics unveils Harrow Loop routing system",
      "Vellum Robotics unveiled the Harrow Loop routing system for autonomous warehouse vehicles with depot trials starting next quarter.",
    );
    const alphaParaphrase = item(
      "alpha-paraphrase",
      "The Harrow Loop launch: autonomous route planner now available",
      "The Harrow Loop routing launch is live: the autonomous route planner from Vellum Robotics is now available at twelve depots for warehouse vehicles.",
    );
    const unrelated = item(
      "unrelated",
      "Vineyard harvest automation",
      "Grape harvesters and vineyard tractor economics, unrelated text entirely here.",
    );
    const pairs = candidatePairs([unrelated, alphaParaphrase, alpha], { budget: 1 });
    expect(pairs).toEqual([["alpha", "alpha-paraphrase"]]);
  });

  it("caps at the budget and never emits self or duplicate pairs", () => {
    const items = Array.from({ length: 20 }, (_, index) =>
      item(`i${index}`, `Story about shared robotics topic number ${index}`),
    );
    const pairs = candidatePairs(items, { budget: 10 });
    expect(pairs).toHaveLength(10);
    const seen = new Set<string>();
    for (const [left, right] of pairs) {
      expect(left).not.toBe(right);
      expect(seen.has(`${left}|${right}`)).toBe(false);
      seen.add(`${left}|${right}`);
    }
  });
});

describe("sameStoryVerdict", () => {
  it("requires the same probability to clear the frozen threshold", () => {
    expect(
      sameStoryVerdict(
        { same: GROUPING_VERDICT_THRESHOLD, different: 0.05, ambiguous: 0.05 },
        GROUPING_QUESTION_REVISION,
      ),
    ).toBe(true);
    expect(
      sameStoryVerdict(
        { same: GROUPING_VERDICT_THRESHOLD - 0.01, different: 0.5, ambiguous: 0.05 },
        GROUPING_QUESTION_REVISION,
      ),
    ).toBe(false);
  });

  it("returns false for missing, out-of-range, or revision-mismatched verdicts", () => {
    expect(sameStoryVerdict(undefined, GROUPING_QUESTION_REVISION)).toBe(false);
    expect(
      sameStoryVerdict(
        { same: Number.NaN, different: 0.2, ambiguous: 0.2 },
        GROUPING_QUESTION_REVISION,
      ),
    ).toBe(false);
    expect(
      sameStoryVerdict({ same: 1.5, different: 0.2, ambiguous: 0.2 }, GROUPING_QUESTION_REVISION),
    ).toBe(false);
    expect(
      sameStoryVerdict(
        { same: 0.99, different: 0.2, ambiguous: 0.2 },
        GROUPING_QUESTION_REVISION + 1,
      ),
    ).toBe(false);
  });
});

describe("applyPairVerdicts", () => {
  it("merges only pairs whose verdict clears the threshold", () => {
    const items = [
      item("a", "Atlas launch announcement"),
      item("b", "Atlas launch confirmation from a second outlet"),
      item("c", "Beacon platform general availability"),
    ];
    const groups = applyPairVerdicts(
      items,
      [
        ["a", "b"],
        ["a", "c"],
        ["b", "c"],
      ],
      new Map([
        ["a|b", { same: 0.95, different: 0.02, ambiguous: 0.03 }],
        ["a|c", { same: 0.2, different: 0.7, ambiguous: 0.1 }],
        ["b|c", { same: 0.5, different: 0.3, ambiguous: 0.2 }],
      ]),
      GROUPING_QUESTION_REVISION,
    );
    expect(groups.map((group) => [...group].sort())).toEqual([["a", "b"], ["c"]]);
  });

  it("keeps items in separate groups when a verdict is missing", () => {
    const items = [item("a", "one"), item("b", "two")];
    const groups = applyPairVerdicts(items, [["a", "b"]], new Map(), GROUPING_QUESTION_REVISION);
    expect(groups.map((group) => [...group].sort())).toEqual([["a"], ["b"]]);
  });

  it("is order-independent: any permutation of items yields the same partition", () => {
    const items = [
      item("a", "Atlas launch"),
      item("b", "Atlas ships"),
      item("c", "Beacon ships"),
      item("d", "Beacon available"),
    ];
    const verdicts = new Map([
      ["a|b", { same: 0.9, different: 0.05, ambiguous: 0.05 }],
      ["c|d", { same: 0.9, different: 0.04, ambiguous: 0.06 }],
    ]);
    const forward = applyPairVerdicts(
      items,
      [
        ["a", "b"],
        ["a", "c"],
        ["a", "d"],
        ["b", "c"],
        ["b", "d"],
        ["c", "d"],
      ],
      verdicts,
      GROUPING_QUESTION_REVISION,
    );
    const reversed = applyPairVerdicts(
      [...items].reverse(),
      [
        ["a", "b"],
        ["a", "c"],
        ["a", "d"],
        ["b", "c"],
        ["b", "d"],
        ["c", "d"],
      ],
      verdicts,
      GROUPING_QUESTION_REVISION,
    );
    const normalize = (partition: Set<string>[]) =>
      partition
        .map((group) => [...group].sort())
        .sort((left, right) => left.join("|").localeCompare(right.join("|")));
    expect(normalize(reversed)).toEqual(normalize(forward));
  });

  it("never merges two items whose pair verdict is below threshold", () => {
    const items = [item("a", "one"), item("b", "two"), item("c", "three")];
    /* b-c and a-c strongly same, a-b below: transitive merging would weld all
       three; per-pair gating must keep a and b apart. */
    const groups = applyPairVerdicts(
      items,
      [
        ["a", "b"],
        ["a", "c"],
        ["b", "c"],
      ],
      new Map([
        ["a|c", { same: 0.95, different: 0.03, ambiguous: 0.02 }],
        ["b|c", { same: 0.95, different: 0.03, ambiguous: 0.02 }],
        ["a|b", { same: 0.2, different: 0.6, ambiguous: 0.2 }],
      ]),
      GROUPING_QUESTION_REVISION,
    );
    const membership = new Set(groups.map((group) => [...group].sort().join("|")));
    /* c joins a's clique first-fit; b stays a singleton because its pair with
       a failed, even though b-c also passed. */
    expect(membership.has("a|c")).toBe(true);
    expect(membership.has("a|b")).toBe(false);
    expect(membership.has("b")).toBe(true);
  });
});

describe("exposed operating constants", () => {
  it("pins the question revision, budget and threshold", () => {
    expect(GROUPING_QUESTION_REVISION).toBeTypeOf("number");
    expect(GROUPING_PAIR_BUDGET).toBe(100);
    expect(GROUPING_VERDICT_THRESHOLD).toBeGreaterThan(0.5);
    expect(GROUPING_VERDICT_THRESHOLD).toBeLessThanOrEqual(1);
  });
});
