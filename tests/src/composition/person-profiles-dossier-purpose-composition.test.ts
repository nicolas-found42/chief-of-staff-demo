import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { CompletionRequest } from "../../../apps/server/src/llm/providers.js";
import { composePersonProfiles } from "../../../apps/server/src/person-profile/composition.js";

/**
 * Dossier extraction's (E1) own composition dependency (issue #418, T2):
 * `completeDossier` must be the closure that actually answers extraction
 * when supplied, and every existing caller that supplies none must keep
 * resolving through `complete` exactly as before the split.
 */

const workspaces: string[] = [];

function workspace(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `dossier-purpose-composition-${label}-`));
  workspaces.push(root);
  return root;
}

afterEach(() => {
  while (workspaces.length > 0) {
    rmSync(workspaces.pop()!, { recursive: true, force: true });
  }
});

const quote = "Maya Chen built Atlas.";

function extractionFixture() {
  return {
    fullName: null,
    employer: null,
    sourceClass: "primary-artifact",
    author: null,
    publishedAt: null,
    claims: [
      {
        id: "atlas",
        section: "work",
        statement: quote,
        status: "supported",
        nature: "statement",
        matchConfidence: "high",
        effectiveFrom: null,
        effectiveTo: null,
        citations: [{ sourceId: "source", quote }],
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

function fetchPort() {
  return async (url: string) => ({
    url,
    status: 200,
    contentType: "text/plain",
    body: quote,
    etag: null,
    lastModified: null,
    retryAfter: null,
  });
}

it("uses its own completeDossier purpose for extraction, leaving complete uncalled", async () => {
  const root = workspace("own-purpose");
  let completeCalls = 0;
  let completeDossierCalls = 0;
  const people = composePersonProfiles({
    workspaceDir: root,
    search: async () => [],
    complete: () => {
      completeCalls += 1;
      return () =>
        Promise.reject(new Error("complete must not be called when completeDossier is set"));
    },
    completeDossier: () => {
      completeDossierCalls += 1;
      return () => Promise.resolve(extractionFixture());
    },
    confirmedTranscripts: () => [],
    transcriptStillConfirmed: () => false,
    researchEnabled: () => true,
    researchTestPorts: { fetch: fetchPort() },
  });
  try {
    const profile = people.research.startFor({
      fullName: "Maya Chen",
      profileUrls: ["https://example.com/maya"],
    });
    await people.research.runNow(profile.id);
    expect(completeDossierCalls).toBeGreaterThan(0);
    expect(completeCalls).toBe(0);
  } finally {
    people.stop();
  }
});

it("passes the effective dossierExtractionPolicy onto the outgoing extraction request (spec #418 §2, §6)", async () => {
  const root = workspace("policy-wired");
  const seen: CompletionRequest[] = [];
  const people = composePersonProfiles({
    workspaceDir: root,
    search: async () => [],
    complete: () => () => Promise.reject(new Error("complete must not be called")),
    completeDossier: () => (request) => {
      seen.push(request);
      return Promise.resolve(extractionFixture());
    },
    dossierExtractionPolicy: () => ({
      version: 1,
      outputTokenCeiling: 4096,
      requestedEffort: "medium",
      shapeStrategy: "full",
    }),
    confirmedTranscripts: () => [],
    transcriptStillConfirmed: () => false,
    researchEnabled: () => true,
    researchTestPorts: { fetch: fetchPort() },
  });
  try {
    const profile = people.research.startFor({
      fullName: "Maya Chen",
      profileUrls: ["https://example.com/maya"],
    });
    await people.research.runNow(profile.id);
    expect(seen.length).toBeGreaterThan(0);
    for (const request of seen) {
      expect(request.outputTokenCeiling).toBe(4096);
      expect(request.reasoningEffort).toBe("medium");
      expect(request.describeResultShape).toBe(true);
    }
  } finally {
    people.stop();
  }
});

it("falls back to complete when no completeDossier is composed, unaffecting existing callers", async () => {
  const root = workspace("fallback");
  let completeCalls = 0;
  const people = composePersonProfiles({
    workspaceDir: root,
    search: async () => [],
    complete: () => {
      completeCalls += 1;
      return () => Promise.resolve(extractionFixture());
    },
    confirmedTranscripts: () => [],
    transcriptStillConfirmed: () => false,
    researchEnabled: () => true,
    researchTestPorts: { fetch: fetchPort() },
  });
  try {
    const profile = people.research.startFor({
      fullName: "Maya Chen",
      profileUrls: ["https://example.com/maya"],
    });
    await people.research.runNow(profile.id);
    expect(completeCalls).toBeGreaterThan(0);
  } finally {
    people.stop();
  }
});
