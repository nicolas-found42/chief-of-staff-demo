import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PersonProfile, PersonResearchCheckpoint } from "@chief-of-staff-demo/shared";
import type { CompleteJson, CompletionRequest } from "../../../apps/server/src/llm/providers.js";
import {
  PersonResearch,
  researchAllowance,
  type ResearchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

/**
 * Validated exact-request reuse of Extraction Parts (issue #381, R1).
 *
 * The hard invariants these fixtures pin: a document with any failed part
 * stays unpublished; a resumed document is served its already-validated
 * parts and pays only for the parts that never succeeded; every key
 * dependency changing is a miss; a served hit passes the same grounding as a
 * fresh answer; hits take no model-call allowance and are neutral to the
 * extraction health latch; and the operation's conclusion stays truthful.
 */

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Long enough for four Extraction Parts; the identity signal sits at the end. */
const FOUR_PART_TEXT =
  "Opening context. ".padEnd(15000, "x") + "x".repeat(60000) + "maya@example.com designed Atlas.";
const TWO_PART_TEXT = "Opening context. ".padEnd(16000, "y") + "maya@example.com leads Atlas.";
const URL = "https://example.com/maya";
/**
 * Three documents of their own. A failed part abandons its document
 * (ADR-0074), so the three consecutive real failures the outage latch needs
 * cannot come from one: they need three documents, each failing once.
 */
const THREE_SOURCE_URLS = [
  "https://example.com/maya-1",
  "https://example.com/maya-2",
  "https://example.com/maya-3",
];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "research-part-reuse-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  return {
    root,
    people,
    dossiers: new PersonDossierStore(root),
    person: people.create({ fullName: "Maya Chen", primaryEmail: "maya@example.com" }),
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

/** What the fake model was asked: the part and the exact text it was given. */
function askedPart(request: CompletionRequest): { part: string; text: string } {
  const user = JSON.parse(request.user) as { document: { part: string; text: string } };
  return { part: user.document.part, text: user.document.text };
}

/** One grounded claim per part, quoting the part's own opening characters. */
function answer(part: string, text: string) {
  return {
    fullName: "Maya Chen",
    employer: null,
    sourceClass: "primary-artifact",
    author: null,
    publishedAt: null,
    claims: [
      {
        id: "claim",
        section: "work",
        statement: `Part ${part} statement.`,
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        citations: [{ sourceId: "source", quote: text.slice(0, 40) }],
        supports: [],
        supersedes: [],
        changeReason: null,
      },
    ],
    works: [],
    expertise: [],
    connections: [],
    sections: [],
  };
}

/**
 * A fake model seam that answers every part except the ones named in
 * `failing`, which fail at the boundary. Records which parts it was asked.
 */
function fakeModel(failing: Set<string> = new Set()) {
  const asked: string[] = [];
  const complete = vi.fn(async (request: CompletionRequest) => {
    const { part, text } = askedPart(request);
    asked.push(part);
    if (failing.has(part)) throw new Error("provider failed");
    return answer(part, text);
  });
  return { asked, complete };
}

function research(
  deps: { dossiers: PersonDossierStore; people: WorkspacePersonProfiles },
  model: ReturnType<typeof fakeModel>,
  options: { text?: string; identity?: string | null; seeds?: boolean; reuse?: boolean } = {},
) {
  return new PersonResearch({
    dossiers: deps.dossiers,
    people: deps.people,
    seeds: () => (options.seeds === false ? [] : ["Maya"]),
    search: async () => [{ url: URL, title: "Maya", snippet: "maya@example.com" }],
    readSource: read(options.text ?? FOUR_PART_TEXT),
    complete: model.complete,
    operationModels: () => ({
      complete: model.complete,
      ...(options.identity === null ? {} : { identity: options.identity ?? "fake:model-a" }),
    }),
    ...(options.reuse === undefined ? {} : { reuseExtractionParts: options.reuse }),
  });
}

/** Runs the operation once against a document whose last part fails. */
async function interruptedFirstRun(
  fx: ReturnType<typeof fixture>,
  text = FOUR_PART_TEXT,
  lastPart = "4/4",
) {
  const model = fakeModel(new Set([lastPart]));
  let checkpoint: PersonResearchCheckpoint | undefined;
  const outcome = await research(fx, model, { text }).run(
    fx.person,
    researchAllowance({
      saveCheckpoint: (value) => {
        checkpoint = value;
      },
    }),
  );
  return { model, checkpoint: checkpoint!, outcome };
}

function resume(
  fx: ReturnType<typeof fixture>,
  model: ReturnType<typeof fakeModel>,
  checkpoint: PersonResearchCheckpoint,
  options: Parameters<typeof research>[2] & { allowance?: Partial<ResearchAllowance> } = {},
) {
  const profile = fx.people.get(fx.person.id) ?? fx.person;
  return research(fx, model, { seeds: false, ...options }).run(
    profile,
    researchAllowance({ checkpoint, ...options.allowance }),
  );
}

/** What `fixture()` hands a run: the Workspace, its dossier store, and the Profile. */
interface Fixture {
  root: string;
  people: WorkspacePersonProfiles;
  dossiers: PersonDossierStore;
  person: PersonProfile;
}

/** The extraction seam these fixtures drive: every part it was asked, and the mock. */
interface FakeModel {
  asked: string[];
  complete: CompleteJson;
}

/**
 * One operation over the three documents: all three are read in one batch, and
 * each part is asked under its own document's title, so three documents fail
 * as three documents rather than one document thrice.
 */
function researchAcross(fx: Fixture, model: FakeModel) {
  return new PersonResearch({
    dossiers: fx.dossiers,
    people: fx.people,
    seeds: () => ["Maya"],
    search: async () =>
      THREE_SOURCE_URLS.map((url, index) => ({
        url,
        title: `Maya ${String(index + 1)}`,
        snippet: "maya@example.com",
      })),
    readSource: read(FOUR_PART_TEXT),
    complete: model.complete,
    operationModels: () => ({ complete: model.complete, identity: "fake:model-a" }),
  });
}

describe("a document with a failed part", () => {
  it("stays unpublished with its source retained and its successful parts checkpointed", async () => {
    const fx = fixture();
    const { model, checkpoint, outcome } = await interruptedFirstRun(fx);
    expect(model.asked).toEqual(["1/4", "2/4", "3/4", "4/4"]);
    expect(outcome.operation.modelCalls).toBe(4);
    expect(outcome.operation.modelCallsReused ?? 0).toBe(0);
    /* Nothing published, so the useful-output-vs-cost summary has nothing
       to date (#381, Step 0). */
    expect(outcome.operation.firstPublishedAt).toBeUndefined();
    /* Nothing published: the reader sees no claim from a document that did
       not validate as a whole. */
    expect(fx.dossiers.get(fx.person.id)?.claims ?? []).toEqual([]);
    /* The source is retained and resumable, exactly as before. */
    expect(checkpoint.pendingSourceIds).toHaveLength(1);
    const source = fx.dossiers.source(fx.person.id, checkpoint.pendingSourceIds![0]);
    expect(source?.extractionCoverage).toBe("unattempted");
    /* The validated parts are the checkpoints: three, never the failed fourth. */
    expect(fx.dossiers.extractionParts(fx.person.id)).toHaveLength(3);
  });

  it("resumes by reusing the validated parts, extracting only the failed one, and publishing the whole document", async () => {
    const fx = fixture();
    const { checkpoint } = await interruptedFirstRun(fx);
    const model = fakeModel();
    const outcome = await resume(fx, model, checkpoint);
    expect(model.asked).toEqual(["4/4"]);
    expect(outcome.operation.modelCalls).toBe(1);
    expect(outcome.operation.modelCallsReused).toBe(3);
    expect(outcome.operation.firstPublishedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const dossier = fx.dossiers.get(fx.person.id);
    expect(dossier?.claims.map((claim) => claim.statement).sort()).toEqual([
      "Part 1/4 statement.",
      "Part 2/4 statement.",
      "Part 3/4 statement.",
      "Part 4/4 statement.",
    ]);
    /* Every replayed quote is still a verbatim substring of the retained text. */
    for (const claim of dossier?.claims ?? [])
      for (const citation of claim.citations)
        expect(fx.dossiers.source(fx.person.id, citation.sourceId)?.text).toContain(citation.quote);
    /* Provenance and dating are produced exactly as a fresh extraction's. */
    expect(dossier?.claims.every((claim) => claim.matchConfidence === "high")).toBe(true);
    const reused = outcome.operation.attempts.filter((a) => a.code === "model-call-reused");
    expect(reused).toHaveLength(3);
    expect(reused.map((a) => a.configuration?.extractionPart).sort()).toEqual([
      "1/4",
      "2/4",
      "3/4",
    ]);
    /* A hit records shape, never content. */
    for (const attempt of reused) expect(JSON.stringify(attempt)).not.toContain("Opening context");
  });

  it("serves no hit when the switch is off", async () => {
    const fx = fixture();
    const { checkpoint } = await interruptedFirstRun(fx);
    const model = fakeModel();
    const outcome = await resume(fx, model, checkpoint, { reuse: false });
    expect(model.asked).toEqual(["1/4", "2/4", "3/4", "4/4"]);
    expect(outcome.operation.modelCalls).toBe(4);
    expect(fx.dossiers.get(fx.person.id)?.claims).toHaveLength(4);
  });
});

/**
 * This operation-level matrix covers the dependencies a resume path can vary:
 * model identity, identity context and prompt scope. The dependencies with
 * no resume-level injection point — request options (provider/binding
 * settings), part selection (offset/length/part count), and schema/version —
 * are pinned directly against `extractionPartKey` in
 * `tests/src/unit/extraction-parts.test.ts` (#381).
 */
describe("invalidation", () => {
  it.each([
    ["the resolved model changes", () => ({ identity: "fake:model-b" })],
    ["no model identity is resolved", () => ({ identity: null })],
    [
      "the identity context (profile revision) changes",
      (fx: ReturnType<typeof fixture>) => {
        fx.people.correct(fx.person.id, { currentEmployer: "Atlas Labs" });
        return {};
      },
    ],
    ["the request scope (prompt) changes", () => ({ allowance: { scope: "current" as const } })],
  ])("misses every part when %s", async (_label, vary) => {
    const fx = fixture();
    const { checkpoint } = await interruptedFirstRun(fx, TWO_PART_TEXT, "2/2");
    expect(fx.dossiers.extractionParts(fx.person.id)).toHaveLength(1);
    const model = fakeModel();
    const outcome = await resume(fx, model, checkpoint, vary(fx));
    expect(model.asked).toEqual(["1/2", "2/2"]);
    expect(outcome.operation.modelCallsReused ?? 0).toBe(0);
  });

  it("misses when a later operation reads the same document afresh", async () => {
    const fx = fixture();
    await interruptedFirstRun(fx, TWO_PART_TEXT, "2/2");
    const model = fakeModel();
    /* A fresh operation: no checkpoint, so a new operation id. Re-reading the
       same URL is fresh research that may find what the last one missed. */
    const outcome = await research(fx, model, { text: TWO_PART_TEXT }).run(
      fx.person,
      researchAllowance(),
    );
    expect(model.asked).toEqual(["1/2", "2/2"]);
    expect(outcome.operation.modelCallsReused ?? 0).toBe(0);
  });

  it("misses when the retained text was tampered with, and never replays an ungrounded quote", async () => {
    const fx = fixture();
    const { checkpoint } = await interruptedFirstRun(fx, TWO_PART_TEXT, "2/2");
    const sourceId = checkpoint.pendingSourceIds![0];
    const path = join(fx.root, "person-source-documents", `${sourceId}.json`);
    const stored = JSON.parse(readFileSync(path, "utf8")) as { text: string };
    stored.text = stored.text.replace("Opening context.", "Altered context.");
    writeFileSync(path, JSON.stringify(stored));
    const model = fakeModel();
    const outcome = await resume(fx, model, checkpoint);
    expect(model.asked).toEqual(["1/2", "2/2"]);
    expect(outcome.operation.modelCallsReused ?? 0).toBe(0);
    for (const claim of fx.dossiers.get(fx.person.id)?.claims ?? [])
      for (const citation of claim.citations) expect(stored.text).toContain(citation.quote);
  });
});

describe("allowance and health", () => {
  it("takes no model-call allowance for a hit and admits the miss before dispatch", async () => {
    const fx = fixture();
    const { checkpoint } = await interruptedFirstRun(fx);
    const model = fakeModel();
    const outcome = await resume(fx, model, checkpoint, { allowance: { maxModelCalls: 1 } });
    expect(model.asked).toEqual(["4/4"]);
    expect(outcome.operation.modelCalls).toBe(1);
    expect(outcome.operation.modelCallsReused).toBe(3);
    expect(fx.dossiers.get(fx.person.id)?.claims).toHaveLength(4);
  });

  it("leaves the document unpublished and resumable when the allowance runs out before the miss", async () => {
    const fx = fixture();
    const { checkpoint } = await interruptedFirstRun(fx);
    const model = fakeModel();
    let saved: PersonResearchCheckpoint | undefined;
    const outcome = await resume(fx, model, checkpoint, {
      allowance: {
        maxModelCalls: 1,
        /* The allowance is spent before the document's miss is reached. */
        reserveModelCall: () => false,
        /* A refused call bounds the operation there and then. This backstop
           has a thousandfold margin over the work below, so it only fires when
           the refusal stops ending the operation — and then in seconds. */
        maxMilliseconds: 10_000,
        saveCheckpoint: (value) => {
          saved = value;
        },
      },
    });
    expect(model.asked).toEqual([]);
    expect(outcome.operation.conclusion).toBe("bounded");
    /* A round or two of this operation — `rounds` continues from the
       checkpoint's pass count — because the refusal ends it instead of being
       re-asked every round until the wall-clock backstop, which spinning
       reached ~320k times. */
    expect(outcome.operation.rounds - checkpoint.pass).toBeLessThan(5);
    expect(fx.dossiers.get(fx.person.id)?.claims ?? []).toEqual([]);
    expect(saved?.pendingSourceIds).toEqual(checkpoint.pendingSourceIds);
  });

  it("keeps served hits neutral to the consecutive-failure latch", async () => {
    const fx = fixture();
    const { checkpoint } = await interruptedFirstRun(fx);
    /* Resumed: three hits, then the only fresh call fails. The hits are not
       provider answers, so the operation never saw the provider succeed and
       reports the interruption exactly as an operation that never answered. */
    const model = fakeModel(new Set(["4/4"]));
    const outcome = await resume(fx, model, checkpoint);
    expect(model.asked).toEqual(["4/4"]);
    expect(outcome.operation.conclusion).toBe("interrupted");
    expect(outcome.operation.interruption?.code).toBe("model-boundary-failed");
    expect(fx.dossiers.get(fx.person.id)?.claims ?? []).toEqual([]);
  });

  it("spends three real failures to latch the outage although every document resumes on hits", async () => {
    const fx = fixture();
    /* First run: three documents, each answering two parts and dying on the
       third, so every document leaves two validated parts and stays retained. */
    const first = fakeModel(new Set(["3/4"]));
    let checkpoint: PersonResearchCheckpoint | undefined;
    await researchAcross(fx, first).run(
      fx.person,
      researchAllowance({
        saveCheckpoint: (value) => {
          checkpoint = value;
        },
      }),
    );
    expect(fx.dossiers.extractionParts(fx.person.id)).toHaveLength(6);
    expect(checkpoint!.pendingSourceIds).toHaveLength(3);

    /* Resumed: each document serves its two hits and then fails. Six hits are
       not provider answers, so the third real failure is the third in a row
       and the latch stops the operation — three real failures, exactly the
       three that latch an operation with no hits at all, and no document's
       hits ever reach the provider. */
    const model = fakeModel(new Set(["1/4", "2/4", "3/4", "4/4"]));
    const profile = fx.people.get(fx.person.id) ?? fx.person;
    const outcome = await researchAcross(fx, model).run(
      profile,
      researchAllowance({ checkpoint: checkpoint! }),
    );
    expect(model.asked).toEqual(["3/4", "3/4", "3/4"]);
    expect(outcome.operation.modelCalls).toBe(3);
    expect(outcome.operation.modelCallsReused).toBe(6);
    expect(outcome.operation.conclusion).toBe("interrupted");
    expect(outcome.operation.interruption?.code).toBe("model-boundary-failed");
    expect(fx.dossiers.get(fx.person.id)?.claims ?? []).toEqual([]);
  });

  it("stops serving hits once the operation is no longer active", async () => {
    const fx = fixture();
    const { checkpoint } = await interruptedFirstRun(fx);
    const model = fakeModel();
    const outcome = await resume(fx, model, checkpoint, { allowance: { active: () => false } });
    expect(model.asked).toEqual([]);
    expect(outcome.operation.modelCallsReused ?? 0).toBe(0);
    expect(outcome.operation.conclusion).toBe("interrupted");
  });

  it("stops a resumed document when the Workspace stops being live mid-batch", async () => {
    const fx = fixture();
    /* Two parts validated, the third failed: the resume has two hits in front
       of the miss that ends it. */
    const { checkpoint } = await interruptedFirstRun(fx, FOUR_PART_TEXT, "3/4");
    const model = fakeModel();
    let live = true;
    const outcome = await resume(fx, model, checkpoint, {
      allowance: {
        /* The Profile is paused exactly as the third part's call is admitted:
           the call in flight finishes, nothing after it starts. */
        reserveModelCall: () => {
          live = false;
          return true;
        },
        active: () => live,
      },
    });
    expect(model.asked).toEqual(["3/4"]);
    expect(outcome.operation.modelCalls).toBe(1);
    expect(outcome.operation.modelCallsReused).toBe(2);
    expect(outcome.operation.conclusion).toBe("interrupted");
    expect(fx.dossiers.get(fx.person.id)?.claims ?? []).toEqual([]);
    /* Cancellation cost the document nothing: the parts served and the part
       answered in flight are all still there, and a later resume serves them
       again and publishes the whole document. */
    expect(
      fx.dossiers
        .extractionParts(fx.person.id)
        .map((part) => part.part)
        .sort(),
    ).toEqual(["1/4", "2/4", "3/4"]);
    const after = fakeModel();
    const finished = await resume(fx, after, checkpoint);
    expect(after.asked).toEqual(["4/4"]);
    expect(finished.operation.modelCallsReused).toBe(3);
    expect(fx.dossiers.get(fx.person.id)?.claims).toHaveLength(4);
  });
});

describe("privacy", () => {
  it("purges a profile's part checkpoints with the profile", async () => {
    const fx = fixture();
    await interruptedFirstRun(fx);
    expect(fx.dossiers.extractionParts(fx.person.id)).toHaveLength(3);
    fx.dossiers.privacyDelete(fx.person.id);
    expect(fx.dossiers.extractionParts(fx.person.id)).toEqual([]);
  });
});
