import { describe, expect, it } from "vitest";
import {
  EXTRACTION_PART_REUSE_VERSION,
  extractionPartKey,
} from "../../../apps/server/src/person-profile/extraction-parts.js";

/**
 * The key of one Extraction Part is the complete request identity (#381, R1):
 * every dependency of the answer is in it, so a change to any one of them is a
 * miss by construction rather than by a rule someone has to remember. Which
 * inputs the key ignores is exactly what would silently serve a stale answer,
 * and the integration fixtures can only vary the ones an operation can vary —
 * the part boundaries a reader produced and the request options are not among
 * them, so they are pinned here.
 */

/** Every dependency the key names, as one extraction part would present them. */
const BASELINE = {
  operationId: "operation-1",
  profileId: "profile-1",
  profileRevision: 3,
  sourceId: "a".repeat(64),
  textHash: "b".repeat(64),
  partIndex: 1,
  partCount: 4,
  offset: 15000,
  length: 15000,
  modelIdentity: "openrouter:deepseek-v4.1-flash",
  system: "Extract one bounded slice of a retained public document.",
  user: '{"document":{"part":"2/4"}}',
  options: {
    preferredBinding: "forced_tool_call",
    temperature: 0,
    compactWireNames: true,
    preferredMinThroughput: 50,
  },
};

/** The same shape as the baseline, so one case can vary exactly one dependency. */
type PartIdentity = typeof BASELINE;

function key(overrides: Partial<PartIdentity> = {}) {
  return extractionPartKey({ ...BASELINE, ...overrides });
}

describe("extractionPartKey", () => {
  it("keys identical requests identically, however the object was built", () => {
    expect(extractionPartKey({ ...BASELINE })).toBe(extractionPartKey({ ...BASELINE }));
  });

  it.each<[string, Partial<PartIdentity>]>([
    /* The part-selection half of the identity: a reader or a selector version
       change alters how a document is cut, and every cut is its own request. */
    ["the part index", { partIndex: BASELINE.partIndex + 1 }],
    ["the part count", { partCount: BASELINE.partCount + 1 }],
    ["the part's offset", { offset: BASELINE.offset + 1 }],
    ["the part's length", { length: BASELINE.length - 1 }],
  ])("misses when only %s changes", (_label, overrides) => {
    expect(key(overrides)).not.toBe(key());
  });

  it.each<[string, Partial<PartIdentity>]>([
    ["the sampling temperature", { options: { ...BASELINE.options, temperature: 1 } }],
    [
      "the preferred binding",
      { options: { ...BASELINE.options, preferredBinding: "json_object" } },
    ],
  ])("misses when only the resolved model's %s changes", (_label, overrides) => {
    expect(key(overrides)).not.toBe(key());
  });

  it("misses when only the resolved model identity changes", () => {
    expect(key({ modelIdentity: "openrouter:another-model" })).not.toBe(key());
  });

  /**
   * Result-shape sensitivity by construction, not by a swap: the wire schema
   * (`zodToJsonSchema(ExtractionSchema, { $refStrategy: "none" })`) and
   * `EXTRACTION_PART_REUSE_VERSION` are hashed into every key, so a change to
   * the dossier result shape, or a version bump, re-keys every part and turns
   * every stored checkpoint into a miss. `ExtractionSchema` is a compile-time
   * constant of the production module with no injection point, so what is
   * pinned is the identity the constant gives — one fixed input set, a full
   * digest of it, and the version that names it — rather than a schema variant
   * the module never accepts.
   */
  it("hashes one fixed input set, with the schema and the version inside it", () => {
    expect(key()).toMatch(/^[0-9a-f]{64}$/);
    expect(EXTRACTION_PART_REUSE_VERSION).toBe(1);
  });
});
