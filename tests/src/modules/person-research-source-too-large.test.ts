import { describe, expect, test } from "vitest";
import { sourceBodyLimitError } from "../../../apps/server/src/source-adapters/source-body.js";
import { classifyTransportError } from "../../../apps/server/src/person-profile/research-diagnostics.js";

/**
 * The collection-limit failure is deterministic: the transport refuses bodies
 * past the cap, and no amount of retrying shrinks them (workspace evidence
 * 2026-09-19: every podcast feed over 5 MB logged as an unexplained
 * `transport-failed` and was re-fetched to the retry budget's end).
 */
describe("classifyTransportError on the collection limit", () => {
  test("the limit error names its cause instead of falling to transport-failed", () => {
    const classified = classifyTransportError(sourceBodyLimitError());
    expect(classified.code).toBe("source-too-large");
    expect(classified.reason).toContain("collection limit");
  });

  test("the limit error is recognized through a wrapped cause chain", () => {
    const wrapped = new Error("fetch failed", { cause: sourceBodyLimitError() });
    expect(classifyTransportError(wrapped).code).toBe("source-too-large");
  });

  test("a genuine transport failure stays transport-failed", () => {
    const classified = classifyTransportError(new Error("socket hung up"));
    expect(classified.code).toBe("transport-failed");
  });
});
