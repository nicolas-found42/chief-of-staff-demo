import { describe, expect, it } from "vitest";
import {
  createSourceLifecycleGrant,
  defaultRoutePolicyForModel,
  isZdrCompliantModel,
  verifySourceGrant,
} from "../../../apps/server/src/llm/grants.js";

describe("source lifecycle grants and route authorization", () => {
  it("creates a grant with default ZDR policy for standard models", () => {
    const grant = createSourceLifecycleGrant({
      sourceId: "transcript_1",
      purpose: "meeting-debrief",
      model: "deepseek/deepseek-v4.1-flash",
    });

    expect(grant.routePolicy.zdrRequired).toBe(true);
    expect(grant.routePolicy.dataCollection).toBe("deny");
    expect(grant.revokedAt).toBeNull();
    expect(verifySourceGrant(grant, "deepseek/deepseek-v4.1-flash").ok).toBe(true);
  });

  it("creates a non-ZDR exception grant for nex-agi/nex-n2.5-mini:free", () => {
    const policy = defaultRoutePolicyForModel("nex-agi/nex-n2.5-mini:free");
    expect(policy.zdrRequired).toBe(false);
    expect(policy.dataCollection).toBe("deny");
    expect(policy.allowNonZdrException).toBe(true);

    const grant = createSourceLifecycleGrant({
      sourceId: "transcript_2",
      purpose: "meeting-debrief",
      model: "nex-agi/nex-n2.5-mini:free",
    });
    expect(verifySourceGrant(grant, "nex-agi/nex-n2.5-mini:free").ok).toBe(true);
  });

  it.each([
    "thinkingmachines/inkling-small:free",
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
  ])("treats the free campaign model %s as a non-ZDR exception (#363)", (model) => {
    expect(defaultRoutePolicyForModel(model)).toEqual({
      zdrRequired: false,
      dataCollection: "deny",
      allowNonZdrException: true,
    });
    const strict = createSourceLifecycleGrant({
      sourceId: "transcript_3",
      purpose: "validation-campaign",
      model: "deepseek/deepseek-v4.1-flash",
    });
    expect(verifySourceGrant(strict, model).ok).toBe(false);
    expect(verifySourceGrant(strict, model).reason).toContain("Zero Data Retention");
    const excepted = createSourceLifecycleGrant({
      sourceId: "transcript_3",
      purpose: "validation-campaign",
      model,
    });
    expect(verifySourceGrant(excepted, model).ok).toBe(true);
  });

  it("refuses dispatch when grant is missing or null", () => {
    const verification = verifySourceGrant(null, "deepseek/deepseek-v4.1-flash");
    expect(verification.ok).toBe(false);
    expect(verification.reason).toContain("No source lifecycle grant");
  });

  it("refuses dispatch when grant has been revoked", () => {
    const grant = createSourceLifecycleGrant({
      sourceId: "transcript_1",
      purpose: "meeting-debrief",
      model: "deepseek/deepseek-v4.1-flash",
    });
    grant.revokedAt = new Date().toISOString();

    const verification = verifySourceGrant(grant, "deepseek/deepseek-v4.1-flash");
    expect(verification.ok).toBe(false);
    expect(verification.reason).toContain("revoked");
  });

  it("refuses dispatch when approved endpoints set is empty", () => {
    const grant = createSourceLifecycleGrant({
      sourceId: "transcript_1",
      purpose: "meeting-debrief",
      model: "deepseek/deepseek-v4.1-flash",
      policy: { allowedEndpoints: [] },
    });

    const verification = verifySourceGrant(grant, "deepseek/deepseek-v4.1-flash");
    expect(verification.ok).toBe(false);
    expect(verification.reason).toContain("Empty approved endpoints");
  });

  it("refuses non-ZDR model when policy strictly requires ZDR without exception", () => {
    const grant = createSourceLifecycleGrant({
      sourceId: "transcript_1",
      purpose: "meeting-debrief",
      model: "deepseek/deepseek-v4.1-flash",
      policy: { zdrRequired: true, allowNonZdrException: false },
    });

    expect(isZdrCompliantModel("nex-agi/nex-n2.5-mini:free", grant.routePolicy)).toBe(false);
    const verification = verifySourceGrant(grant, "nex-agi/nex-n2.5-mini:free");
    expect(verification.ok).toBe(false);
    expect(verification.reason).toContain("does not satisfy required Zero Data Retention");
  });
});
