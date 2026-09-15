import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DossierExtractionPolicy } from "@chief-of-staff-demo/shared";
import type { CompleteJson, CompletionRequest } from "../../../apps/server/src/llm/providers.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import {
  ClaimsSliceSchema,
  IdentitySliceSchema,
  StructureSliceSchema,
  type Extraction,
} from "../../../apps/server/src/person-profile/extraction-parts.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";
import {
  denseMultiClaim,
  wrongSubjectAdmittedClaimIds,
  wrongSubjectDocument,
  wrongSubjectExtraction,
  wrongSubjectWithheldClaimIds,
} from "./person-research-extraction-boundary-fixtures.js";

/**
 * The `"sliced"` shape strategy (spec #418 §5): the same model answers three
 * field-complete requests — identity/source metadata, grounded claims,
 * dossier structure — instead of one, and the three merge deterministically
 * into the unchanged `ExtractionSchema`. These fixtures drive the real
 * PersonResearch + stores seam (fake model/search/read dependencies,
 * isolated Workspace data), the seam spec #418's Testing Decisions names for
 * this behavior, rather than asserting on private helper call order.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const URL = "https://example.com/dana-okonkwo";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "research-slice-strategy-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  return {
    root,
    people,
    dossiers: new PersonDossierStore(root),
    person: people.create({ fullName: "Dana Okonkwo", currentEmployer: "Vellum Robotics" }),
  };
}

function read(text: string) {
  return async (url: string) => ({
    text,
    capturedAt: null,
    completeness: "full" as const,
    access: "retrieved" as const,
    outboundUrls: [],
    family: "general-discovery" as const,
    route: "fixture",
    upstreamIndex: null,
    publishedAt: null,
    author: null,
    anchors: [],
    provenanceNote: null,
    sourceVersion: null,
    rights: null,
    finalUrl: url,
  });
}

const slicedPolicy = (
  overrides: Partial<DossierExtractionPolicy> = {},
): DossierExtractionPolicy => ({
  version: 1,
  outputTokenCeiling: 8192,
  requestedEffort: "low",
  shapeStrategy: "sliced",
  fallback: null,
  ...overrides,
});

/**
 * Splits a full Extraction fixture into its three slice responsibilities.
 * Strips any `work.url` — a published work's URL becomes a real expansion
 * lead for the next round (`deriveLeads`), and the fake `readSource` below
 * answers every URL with the same text, which would otherwise send the
 * operation around a second, irrelevant document read for these tests.
 */
function toSlices(extraction: Extraction) {
  return {
    identity: {
      fullName: extraction.fullName,
      employer: extraction.employer,
      sourceClass: extraction.sourceClass,
      author: extraction.author,
      publishedAt: extraction.publishedAt,
    },
    claims: { claims: extraction.claims },
    structure: {
      works: extraction.works.map((work) => ({ ...work, url: null })),
      expertise: extraction.expertise,
      connections: extraction.connections,
      sections: extraction.sections,
    },
  };
}

/**
 * A fake model that answers each of the three slice schemas from a fixed
 * split, identified by the exact schema object `models.complete` was called
 * with (the production seam passes the schema through unchanged, so this
 * needs no fragile parsing of the request body to tell slices apart).
 */
function fakeSlicedModel(slices: ReturnType<typeof toSlices>) {
  const askedSchemas: string[] = [];
  const complete: CompleteJson = vi.fn(async (request: CompletionRequest) => {
    if (request.schema === IdentitySliceSchema) {
      askedSchemas.push("identity");
      return slices.identity;
    }
    if (request.schema === ClaimsSliceSchema) {
      askedSchemas.push("claims");
      return slices.claims;
    }
    if (request.schema === StructureSliceSchema) {
      askedSchemas.push("structure");
      return slices.structure;
    }
    askedSchemas.push("full");
    return { ...slices.identity, ...slices.claims, ...slices.structure };
  });
  return { askedSchemas, complete };
}

function research(
  fx: ReturnType<typeof fixture>,
  model: { complete: CompleteJson },
  policy: DossierExtractionPolicy,
  text: string,
) {
  return new PersonResearch({
    dossiers: fx.dossiers,
    people: fx.people,
    seeds: () => ["Dana"],
    search: async () => [{ url: URL, title: "Dana", snippet: "" }],
    readSource: read(text),
    complete: model.complete,
    operationModels: () => ({ complete: model.complete, identity: "fake:model-a" }),
    dossierExtractionPolicy: () => policy,
  });
}

describe("sliced extraction strategy", () => {
  it("recombines three slice calls into the complete downstream contract", async () => {
    const fx = fixture();
    const model = fakeSlicedModel(toSlices(denseMultiClaim.extraction));
    await research(fx, model, slicedPolicy(), denseMultiClaim.documentText).run(
      fx.person,
      researchAllowance(),
    );

    expect(model.askedSchemas).toEqual(["identity", "claims", "structure"]);
    const published = fx.dossiers.get(fx.person.id);
    expect(published).not.toBeNull();
    expect(published?.claims.map((c) => c.statement).sort()).toEqual(
      denseMultiClaim.extraction.claims.map((c) => c.statement).sort(),
    );
    expect(published?.works).toHaveLength(denseMultiClaim.extraction.works.length);
    expect(published?.expertise).toHaveLength(denseMultiClaim.extraction.expertise.length);
    expect(published?.connections).toHaveLength(denseMultiClaim.extraction.connections.length);
    expect(published?.sections.length).toBeGreaterThan(0);
    /* Inter-record references remapped coherently across slices: the
       structure slice's own claimIds (invented independently of the claims
       slice's ids, only told which ones to reuse) still resolve to real,
       admitted claims after the merge. */
    const claimIds = new Set(published?.claims.map((c) => c.id));
    for (const work of published?.works ?? [])
      for (const id of work.claimIds) expect(claimIds.has(id)).toBe(true);
    for (const connection of published?.connections ?? [])
      for (const id of connection.claimIds) expect(claimIds.has(id)).toBe(true);
  });

  it("drops a claim with an invalid citation and the structure record that depended on it, inventing nothing", async () => {
    const fx = fixture();
    const documentText = "Dana Okonkwo is a systems engineer at Vellum Robotics.";
    const badClaim = {
      id: "c1",
      section: "career" as const,
      statement: "Okonkwo founded a company that does not appear in the document.",
      status: "supported" as const,
      nature: "statement" as const,
      matchConfidence: "high" as const,
      effectiveFrom: null,
      effectiveTo: null,
      citations: [{ sourceId: "source", quote: "This quote never appears in the document." }],
      supports: [],
      supersedes: [],
      changeReason: null,
    };
    const dependentWork = {
      id: "w1",
      title: "Invented Company",
      url: null,
      kind: "company" as const,
      startedAt: null,
      endedAt: null,
      claimIds: [badClaim.id],
      contribution: null,
      teamContribution: null,
      authority: [],
      scale: [],
      constraints: [],
      outcomes: [],
    };
    const complete: CompleteJson = vi.fn(async (request: CompletionRequest) => {
      if (request.schema === IdentitySliceSchema)
        return {
          fullName: "Dana Okonkwo",
          employer: "Vellum Robotics",
          sourceClass: "independent-account",
          author: null,
          publishedAt: null,
        };
      if (request.schema === ClaimsSliceSchema) return { claims: [badClaim] };
      if (request.schema === StructureSliceSchema)
        return { works: [dependentWork], expertise: [], connections: [], sections: [] };
      throw new Error("unexpected schema");
    });
    await research(fx, { complete }, slicedPolicy(), documentText).run(
      fx.person,
      researchAllowance(),
    );

    const published = fx.dossiers.get(fx.person.id);
    /* The ungrounded claim never survives parsePartial's citation check, and
       the work that depended on it is pruned by the same dependent-record
       rule that already applies to a single-call reply — nothing invented to
       fill the gap. */
    expect(published?.claims ?? []).toEqual([]);
    expect(published?.works ?? []).toEqual([]);
  });

  it("fails the whole part when one required slice fails, never publishing a partial result", async () => {
    const fx = fixture();
    const slices = toSlices(denseMultiClaim.extraction);
    const complete: CompleteJson = vi.fn(async (request: CompletionRequest) => {
      if (request.schema === IdentitySliceSchema) return slices.identity;
      if (request.schema === ClaimsSliceSchema) throw new Error("the model boundary failed");
      if (request.schema === StructureSliceSchema) return slices.structure;
      throw new Error("unexpected schema");
    });
    const outcome = await research(
      fx,
      { complete },
      slicedPolicy(),
      denseMultiClaim.documentText,
    ).run(fx.person, researchAllowance({ maxModelCalls: 10, maxMilliseconds: 10_000 }));

    /* An incomplete slice plan is never a complete empty Extraction: nothing
       is published, and the source stays retained/resumable exactly as a
       single-call failure leaves it (ADR-0074). */
    expect(fx.dossiers.get(fx.person.id)?.claims ?? []).toEqual([]);
    expect(outcome.operation.firstPublishedAt).toBeUndefined();
    const [sourceId] = [...outcome.operation.attempts]
      .map((a) => a.target)
      .filter((t) => t === URL);
    expect(sourceId).toBe(URL);
    /* The failure diagnostic names which slice failed, so a future fallback
       escalation could target exactly that unit within its part (spec #418
       §5), instead of the whole part as under the "full" strategy. */
    expect(outcome.operation.attempts).toContainEqual(
      expect.objectContaining({
        stage: "extraction",
        code: "model-boundary-failed",
        target: URL,
        configuration: expect.objectContaining({ extractionSlice: "claims" }),
      }),
    );
  });

  it("preserves ADR-0097 subject withholding through the slice path", async () => {
    const fx = fixture();
    const slices = toSlices(wrongSubjectExtraction);
    const model = fakeSlicedModel(slices);
    const outcome = await research(fx, model, slicedPolicy(), wrongSubjectDocument).run(
      fx.person,
      researchAllowance(),
    );

    const published = fx.dossiers.get(fx.person.id);
    const publishedStatements = new Set(published?.claims.map((c) => c.statement) ?? []);
    const admitted = wrongSubjectExtraction.claims.filter((c) =>
      wrongSubjectAdmittedClaimIds.includes(c.id),
    );
    const withheld = wrongSubjectExtraction.claims.filter((c) =>
      wrongSubjectWithheldClaimIds.includes(c.id),
    );
    for (const claim of admitted) expect(publishedStatements.has(claim.statement)).toBe(true);
    for (const claim of withheld) expect(publishedStatements.has(claim.statement)).toBe(false);
    /* Withheld, never silently dropped. */
    expect(outcome.operation.attempts).toContainEqual(
      expect.objectContaining({ stage: "extraction", code: "off-subject-claim" }),
    );
  });
});

describe("shape strategy default", () => {
  it('stays "full" unless a policy explicitly selects "sliced"', async () => {
    const fx = fixture();
    const model = fakeSlicedModel(toSlices(denseMultiClaim.extraction));
    await new PersonResearch({
      dossiers: fx.dossiers,
      people: fx.people,
      seeds: () => ["Dana"],
      search: async () => [{ url: URL, title: "Dana", snippet: "" }],
      readSource: read(denseMultiClaim.documentText),
      complete: model.complete,
      operationModels: () => ({ complete: model.complete, identity: "fake:model-a" }),
      /* No dossierExtractionPolicy at all — the pre-#418 configuration. */
    }).run(fx.person, researchAllowance());

    /* Absent a policy, the request is the original unsliced call: none of
       the three narrower slice schemas is ever asked for. */
    expect(model.askedSchemas).toEqual(["full"]);
  });
});
