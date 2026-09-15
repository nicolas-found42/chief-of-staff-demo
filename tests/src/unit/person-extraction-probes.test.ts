import { describe, expect, it } from "vitest";
import {
  EXTRACTION_MODEL,
  EXTRACTION_PROVIDER,
  MERCURY_MAX_COMPLETION_TOKENS,
  PROBE_CELL_IDS,
  LiveDispatchNotAuthorizedError,
  assertLiveDispatchAuthorized,
  buildProbeCells,
  evaluateAdmissibility,
  freezeManifest,
  runManifest,
  sanitizeAttempt,
} from "../../../scripts/person-extraction-probes.mjs";
import type { ModelAttemptEvent } from "@chief-of-staff-demo/shared";

/**
 * Deterministic coverage for spec #418 T8's probe manifest/runner logic:
 * freezing, cell identity, refusal to dispatch without authorization, and
 * sanitization. No network access anywhere in this file — live dispatch is
 * exercised separately, by hand, against the real provider.
 */

describe("buildProbeCells", () => {
  it("declares exactly the six spec-named cell categories plus the recovery/qualification split", () => {
    const cells = buildProbeCells(65536);
    expect(cells.map((cell) => cell.id).sort()).toEqual([...PROBE_CELL_IDS].sort());
  });

  it("holds every field constant except each cell's own declared variable", () => {
    const cells = buildProbeCells(65536);
    const budget16k = cells.find((c) => c.id === "explicit-budget-16384")!;
    const budget64k = cells.find((c) => c.id === "explicit-budget-65536")!;
    // Same fixtures/repetitions/binding; only the ceiling itself differs.
    expect(budget16k.fixtures).toEqual(budget64k.fixtures);
    expect(budget16k.repetitions).toBe(budget64k.repetitions);
    expect(budget16k.options.preferredBinding).toBe(budget64k.options.preferredBinding);
    expect(budget16k.options.outputTokenCeiling).not.toBe(budget64k.options.outputTokenCeiling);
  });

  it("the repaired-full cell runs the entire qualification fixture set", () => {
    const repaired = buildProbeCells(65536).find((c) => c.id === "repaired-full")!;
    expect(repaired.fixtures.length).toBe(5);
    expect(repaired.options.outputTokenCeiling).toBe(65536);
    expect(repaired.options.describeResultShape).toBe(true);
  });

  it("the forced-tool-recovery cell deliberately overrides the preferred binding", () => {
    const recovery = buildProbeCells(65536).find((c) => c.id === "forced-tool-recovery")!;
    expect(recovery.options.preferredBinding).toBeUndefined();
  });

  it("respects a different selected ceiling passed to it", () => {
    const cells = buildProbeCells(32768);
    expect(cells.find((c) => c.id === "repaired-full")!.options.outputTokenCeiling).toBe(32768);
    // The candidate cells stay pinned to their own declared values regardless.
    expect(cells.find((c) => c.id === "explicit-budget-65536")!.options.outputTokenCeiling).toBe(
      MERCURY_MAX_COMPLETION_TOKENS,
    );
  });
});

describe("freezeManifest", () => {
  const frozenNow = () => new Date("2026-09-15T00:00:00.000Z");

  it("is deterministic: identical inputs produce an identical manifest hash", () => {
    const a = freezeManifest({
      selectedCeiling: 65536,
      policyVersion: 1,
      now: frozenNow,
      codeVersion: "abc",
    });
    const b = freezeManifest({
      selectedCeiling: 65536,
      policyVersion: 1,
      now: frozenNow,
      codeVersion: "abc",
    });
    expect(a.manifestHash).toBe(b.manifestHash);
  });

  it("a changed experiment (a different selected ceiling) gets a new identity", () => {
    const a = freezeManifest({ selectedCeiling: 65536, policyVersion: 1, now: frozenNow });
    const b = freezeManifest({ selectedCeiling: 16384, policyVersion: 1, now: frozenNow });
    expect(a.manifestHash).not.toBe(b.manifestHash);
  });

  it("records the exact authorized model/provider and the declared, non-authorized scope", () => {
    const manifest = freezeManifest({ selectedCeiling: 65536, policyVersion: 1, now: frozenNow });
    expect(manifest.model).toBe(EXTRACTION_MODEL);
    expect(manifest.model).not.toContain("preview");
    expect(manifest.provider).toBe(EXTRACTION_PROVIDER);
    expect(manifest.authorization.notAuthorized).toMatch(/person-research-benchmark/);
  });

  it("carries a schema hash and one input hash per fixture", () => {
    const manifest = freezeManifest({ selectedCeiling: 65536, policyVersion: 1, now: frozenNow });
    expect(manifest.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(manifest.fixtureHashes).sort()).toEqual(
      [
        "denseMultiClaim",
        "duplicateLocalIdsPartA",
        "noRelevantFacts",
        "sparseIdentityOnly",
        "wrongSubjectDocument",
      ].sort(),
    );
    for (const hash of Object.values(manifest.fixtureHashes))
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("assertLiveDispatchAuthorized", () => {
  const manifest = freezeManifest({ selectedCeiling: 65536, policyVersion: 1 });

  it("refuses dispatch without an API key", () => {
    expect(() =>
      assertLiveDispatchAuthorized({ manifest, hasApiKey: false, confirmed: true }),
    ).toThrow(LiveDispatchNotAuthorizedError);
  });

  it("refuses dispatch without explicit confirmation, even with a key present", () => {
    expect(() =>
      assertLiveDispatchAuthorized({ manifest, hasApiKey: true, confirmed: false }),
    ).toThrow(/confirm-live-spend/);
  });

  it("refuses a model identity other than the exact ADR-0091 string", () => {
    expect(() =>
      assertLiveDispatchAuthorized({
        manifest: { ...manifest, model: "inception/mercury-2.5-preview" },
        hasApiKey: true,
        confirmed: true,
      }),
    ).toThrow(/ADR-0091/);
  });

  it("refuses any route other than openrouter", () => {
    expect(() =>
      assertLiveDispatchAuthorized({
        manifest: { ...manifest, provider: "anthropic" },
        hasApiKey: true,
        confirmed: true,
      }),
    ).toThrow(LiveDispatchNotAuthorizedError);
  });

  it("authorizes when the model, route, key and confirmation all line up", () => {
    expect(() =>
      assertLiveDispatchAuthorized({ manifest, hasApiKey: true, confirmed: true }),
    ).not.toThrow();
  });
});

describe("evaluateAdmissibility", () => {
  const validEmpty = {
    fullName: null,
    employer: null,
    sourceClass: "primary-artifact",
    author: null,
    publishedAt: null,
    claims: [],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  };

  it("admits a legitimate validated empty Extraction", () => {
    const result = evaluateAdmissibility(validEmpty);
    expect(result.admissible).toBe(true);
    expect(result.emptyExtraction).toBe(true);
  });

  it("does not admit a value that fails ExtractionSchema validation (an HTTP-200 empty answer, e.g. null, is not admissible)", () => {
    const result = evaluateAdmissibility(null);
    expect(result.admissible).toBe(false);
    expect(result.validationIssueCount).toBeGreaterThan(0);
  });

  it("admits a populated, schema-valid Extraction and marks it non-empty", () => {
    const result = evaluateAdmissibility({ ...validEmpty, fullName: "Dana Okonkwo" });
    expect(result.admissible).toBe(true);
    expect(result.emptyExtraction).toBe(false);
  });
});

describe("sanitizeAttempt", () => {
  it("carries only shape facts through, never request/response text", () => {
    const event: ModelAttemptEvent = {
      attempt: 1,
      binding: "forced_tool_call",
      provider: "openrouter",
      model: EXTRACTION_MODEL,
      outcome: "succeeded",
      reasoningEffort: "low",
      requestedReasoningEffort: "low",
      systemFingerprint: "fp_test",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0001 },
      diagnostic: null,
      delayMs: 0,
      stoppedReason: null,
    };
    const sanitized = sanitizeAttempt(event, "Inception");
    expect(sanitized).toEqual({
      attempt: 1,
      binding: "forced_tool_call",
      outcome: "succeeded",
      provider: "openrouter",
      model: EXTRACTION_MODEL,
      reasoningEffort: "low",
      requestedReasoningEffort: "low",
      systemFingerprint: "fp_test",
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0.0001 },
      diagnostic: null,
      observedUpstreamRoute: "Inception",
    });
    expect(JSON.stringify(sanitized)).not.toMatch(/Dana Okonkwo|Vellum Robotics/);
  });

  it("records unknown rather than guessing when no route was observed", () => {
    const event: ModelAttemptEvent = {
      attempt: 1,
      binding: "response_format",
      provider: "openrouter",
      model: EXTRACTION_MODEL,
      outcome: "failed",
      diagnostic: {
        classification: "unusable_shape",
        provider: "openrouter",
        model: EXTRACTION_MODEL,
        upstreamServer: null,
        upstreamCode: null,
        binding: "response_format",
        status: 200,
        finishReason: "length",
        bodyBytes: 40,
        topLevelKeys: ["choices"],
        populatedFields: ["choices[0].message.role"],
        emptyFields: ["choices[0].message.content"],
        timeoutMs: null,
        usage: null,
      },
      delayMs: 0,
      stoppedReason: "no further binding",
    };
    const sanitized = sanitizeAttempt(event, "unknown");
    expect(sanitized.observedUpstreamRoute).toBe("unknown");
    expect(sanitized.diagnostic?.emptyFields).toEqual(["choices[0].message.content"]);
  });
});

describe("runManifest (fake completor, no network)", () => {
  it("dispatches every declared fixture x repetition and reports admissibility", async () => {
    const manifest = freezeManifest({ selectedCeiling: 65536, policyVersion: 1 });
    // Narrow to one cheap cell so the fake only needs to answer a few calls.
    manifest.cells = manifest.cells.filter((c) => c.id === "small-shape-control");
    let calls = 0;
    const fakeComplete = async () => {
      calls += 1;
      return {
        fullName: "Dana Okonkwo",
        employer: "Vellum Robotics",
        sourceClass: "primary-artifact",
        author: "Forum Programming Committee",
        publishedAt: "2024-03-01",
        claims: [],
        works: [],
        expertise: [],
        connections: [],
        sections: [],
      };
    };
    const results = await runManifest(manifest, fakeComplete);
    expect(calls).toBe(2); // small-shape-control declares 2 repetitions
    expect(results).toHaveLength(1);
    expect(results[0].repetitions).toHaveLength(2);
    for (const repetition of results[0].repetitions) {
      expect(repetition.finalOutcome).toBe("admitted");
      expect(repetition.admissibility?.admissible).toBe(true);
    }
  });

  it("records a boundary failure honestly instead of throwing out of the manifest", async () => {
    const manifest = freezeManifest({ selectedCeiling: 65536, policyVersion: 1 });
    manifest.cells = manifest.cells.filter((c) => c.id === "small-shape-control");
    manifest.cells[0].repetitions = 1;
    const failing = async () => {
      throw new Error("simulated transport failure");
    };
    const results = await runManifest(manifest, failing);
    expect(results[0].repetitions[0].finalOutcome).toBe("boundary-failure");
  });
});
