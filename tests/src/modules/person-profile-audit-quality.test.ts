import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { PersonDossierStore } from "../../../apps/server/src/person-profile/dossier-store.js";
import {
  PersonResearch,
  researchAllowance,
} from "../../../apps/server/src/person-profile/research.js";
import { WorkspacePersonProfiles } from "../../../apps/server/src/person-profile/profiles.js";
import { PersonProfileStore } from "../../../apps/server/src/person-profile/store.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const url = "https://www.linkedin.com/in/morgan-example/";
const body =
  "About\nI’ve spent four years in operations, and now…\nExperience\nExample Labs\nNew York, United States\n-\n-\n-\n-\n-\n-\nEducation\nExample College\n2018 - 2021";
function asHtml(text: string): string {
  return `<html><body><article>${text
    .split("\n")
    .map((line) => `<p>${line.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</p>`)
    .join("\n")}</article></body></html>`;
}
const extraction = {
  fullName: null,
  employer: null,
  sourceClass: "independent-account",
  author: null,
  publishedAt: null,
  claims: [],
  works: [],
  expertise: [],
  connections: [],
  sections: [],
};
async function replay(
  text: string,
  sourceUrl = url,
  answer: unknown = extraction,
  finalUrl = sourceUrl,
) {
  const root = mkdtempSync(join(tmpdir(), "person-audit-quality-"));
  roots.push(root);
  const dossiers = new PersonDossierStore(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    dossiers,
    lifecycle: [],
  });
  const person = people.create({ profileUrls: [sourceUrl] });
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [],
    fetch: async () => ({
      url: finalUrl,
      status: 200,
      contentType: "text/html",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: asHtml(text),
    }),
    complete: async () => answer,
  });
  const result = await research.run(
    person,
    researchAllowance({ maxModelCalls: 12, maxRequests: 96, maxMilliseconds: 120000 }),
  );
  const sourceId =
    dossiers.get(person.id)?.sourceIds.at(-1) ?? result.operation.retainedSourceIds?.at(-1);
  expect(sourceId).toBeTruthy();
  return {
    result,
    source: dossiers.source(person.id, sourceId!)!,
    dossier: dossiers.get(person.id),
    profile: people.get(person.id),
  };
}

test("audit F8: predominantly empty LinkedIn experience rows remain retained but disclosed as partial", async () => {
  const { source } = await replay(body);
  expect(source.completeness).toBe("partial");
  expect(source.provenanceNote).toMatch(/login-required.*experience/i);
  expect(source.access).toBe("retrieved");
  expect(source.text).toContain("Example College");
});

const audit = new URL(
  "../../../artifacts/person-profile-audit/20260915T215455Z/logs",
  import.meta.url,
).pathname;
test.skipIf(!existsSync(audit))(
  "audit F8: both retained documents disclose the stripped experience rows",
  async () => {
    for (const name of [
      "source-doc-target-url-NO-TITLE.json",
      "source-doc-variant-url-WITH-TITLE.json",
    ]) {
      const document = JSON.parse(readFileSync(join(audit, name), "utf8")) as {
        text: string;
        url: string;
      };
      const { source } = await replay(document.text, document.url);
      expect(source.completeness).toBe("partial");
      expect(source.provenanceNote).toContain("login-required");
    }
  },
);

const claim = (id: string, quote: string) => ({
  id,
  section: "career",
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
});
test("audit F9: the subject's LinkedIn profile is self-report regardless of a model's source classification", async () => {
  const quote = "Morgan designed the Atlas scheduler.";
  for (const title of ["", "Page title: Morgan Example | LinkedIn\n"]) {
    const { source, dossier } = await replay(title + quote, url, {
      ...extraction,
      claims: [claim("work", quote)],
    });
    expect(source.attribution).toBe("self-report");
    expect(dossier?.claims[0]?.status).toBe("claimed");
  }
});

test("audit F5/F7: ambiguous fragments and truncated past roles remain inspectable without current-fact promotion", async () => {
  const roleQuote = "I’ve spent four years in operations";
  const text = `${roleQuote}, and now…\nExample Labs\nBrand briefs included Example Labs.\nAvery built the Atlas scheduler.`;
  const { dossier, profile } = await replay(text, "https://example.com/avery", {
    ...extraction,
    claims: [
      { ...claim("role", roleQuote), fact: { field: "role", value: "Operations" } },
      {
        ...claim("employer", "Example Labs"),
        fact: { field: "currentEmployer", value: "Example Labs" },
      },
      claim("valid", "Avery built the Atlas scheduler."),
    ],
  });
  expect(dossier?.claims).toHaveLength(3);
  for (const item of dossier!.claims.filter(
    (item) => item.fact || item.statement === roleQuote || item.statement === "Example Labs",
  )) {
    expect(item.status).toBe("claimed");
    expect(item.changeReason).toMatch(/citation|truncated/i);
    expect(item.citations).toHaveLength(1);
  }
  expect(profile?.role).toBeNull();
  expect(profile?.currentEmployer).toBeNull();
  expect(dossier?.claims.find((item) => item.statement.includes("built"))?.status).toBe(
    "supported",
  );
});

test("audit F7: even a unique predicate-free citation cannot establish a high-confidence fact", async () => {
  const { dossier, profile } = await replay(
    "Example Labs\nAvery's public biography.",
    "https://example.com/avery",
    {
      ...extraction,
      claims: [
        {
          ...claim("employer", "Example Labs"),
          fact: { field: "currentEmployer", value: "Example Labs" },
        },
      ],
    },
  );
  expect(dossier?.claims).toHaveLength(1);
  expect(dossier?.claims[0]?.status).toBe("claimed");
  expect(profile?.currentEmployer).toBeNull();
});

test("audit F7/F10: structured citation context preserves organizations, credential issuers and education dates", async () => {
  const location = "Harbor City, Northern Region, Example Country";
  const text = `Experience\nExample Labs\n${location}\n-\n-\n-\nEducation\nExample College\n2018 - 2021\nDesign programme\nLicenses & Certifications\nCustomer Experience Fellowship\nExample Institute\nIssued Oct 2022\nOrganizations\nExample Association\nCommunications Chair\nAug 2020 - Present`;
  const { dossier } = await replay(text, url, {
    ...extraction,
    claims: [
      { ...claim("location", location), fact: { field: "background", value: location } },
      {
        ...claim("cert", "Customer Experience Fellowship"),
        fact: { field: "background", value: "Customer Experience Fellowship" },
        effectiveFrom: "2022-10",
      },
      {
        ...claim("org", "Communications Chair"),
        fact: { field: "background", value: "Communications Chair" },
        effectiveFrom: "2020-08",
      },
      claim("edu", "Example College"),
    ],
  });
  expect(dossier?.claims).toHaveLength(4);
  const claims = dossier!.claims;
  const certification = claims.find((item) => item.statement.includes("Fellowship"))!;
  expect(certification.section).toBe("recognition");
  expect(certification.statement).toContain("Example Institute");
  expect(certification.citations[0].quote).toContain("Issued Oct 2022");
  expect(certification.fact).toBeUndefined();
  expect(certification.effectiveTo).toBe("2022-10");
  const organization = claims.find((item) => item.statement.includes("Communications Chair"))!;
  expect(organization.section).toBe("connections");
  expect(organization.statement).toContain("Example Association");
  expect(organization.effectiveFrom).toBe("2020-08");
  expect(organization.effectiveTo).toBeNull();
  const place = claims.find((item) => item.statement === location)!;
  expect(place.section).toBe("context");
  expect(place.fact).toBeUndefined();
  const education = claims.find((item) => item.statement.includes("Example College"))!;
  expect(education.effectiveFrom).toBe("2018");
  expect(education.effectiveTo).toBe("2021");
  expect(education.citations[0].quote).toContain("Design programme");
});

test("audit F3: either URL spelling resolves the name retained in the page title", async () => {
  for (const sourceUrl of [url, url.replace(/\/$/, "")]) {
    const { profile, source } = await replay(
      "Page title: Morgan Example | LinkedIn\nMorgan builds systems.",
      sourceUrl,
      { ...extraction, fullName: "Morgan Example" },
    );
    expect(source.text).toContain("Page title: Morgan Example | LinkedIn");
    expect(profile?.fullName).toBe("Morgan Example");
  }
});

test("audit F7: even a complete sentence repeated in two places is not a unique citation", async () => {
  const quote = "Morgan built Atlas.";
  const { dossier } = await replay(
    `${quote}\nOther context.\n${quote}`,
    "https://example.com/morgan",
    { ...extraction, claims: [claim("repeated", quote)] },
  );
  expect(dossier?.claims[0]?.status).toBe("claimed");
  expect(dossier?.claims[0]?.changeReason).toContain("more than once");
});

test.skipIf(!existsSync(audit))(
  "audit D: retained pair replays recorded claims through the corrected publication path",
  async () => {
    const recorded = JSON.parse(readFileSync(join(audit, "dossier-target.json"), "utf8")) as {
      dossier: { claims: unknown[] };
    };
    const outcomes: Array<Array<{ statement: string; status: string }>> = [];
    for (const name of [
      "source-doc-target-url-NO-TITLE.json",
      "source-doc-variant-url-WITH-TITLE.json",
    ]) {
      const document = JSON.parse(readFileSync(join(audit, name), "utf8")) as {
        text: string;
        url: string;
      };
      const { source, dossier, profile } = await replay(document.text, document.url, {
        ...extraction,
        claims: recorded.dossier.claims,
      });
      expect(source.completeness).toBe("partial");
      expect(source.attribution).toBe("self-report");
      expect(dossier?.claims.length).toBeGreaterThan(0);
      expect(dossier?.claims.every((item) => item.status === "claimed")).toBe(true);
      expect(profile?.role).toBeNull();
      expect(profile?.currentEmployer).toBeNull();
      expect(dossier?.claims.some((item) => item.section === "recognition")).toBe(true);
      expect(dossier?.claims.some((item) => item.section === "connections")).toBe(true);
      outcomes.push(dossier!.claims.map(({ statement, status }) => ({ statement, status })));
    }
    expect(outcomes[0]).toEqual(outcomes[1]);
  },
);

test("audit F8: a complete public profile is not marked partial merely for a sign-in invitation or an ellipsis", async () => {
  const { source } = await replay(
    "Page title: Morgan Example\nAbout\nMorgan builds systems…\nJoin to view profile\nExperience\nMorgan works at Example Labs.\nEducation\nExample College",
  );
  expect(source.completeness).toBe("full");
});

test("audit F10: omitted structured education survives with explicit dates and unknown institutions kept unknown", async () => {
  const text =
    "Education\nExample College\n-\n2018 - 2021\nDesign programme\n-\n2015 - 2017\nLicenses & Certifications";
  const { dossier, profile, source } = await replay(text);
  const education = dossier?.claims.filter((item) => item.section === "career") ?? [];
  expect(education).toHaveLength(2);
  expect(education[0]?.statement).toContain("Example College");
  expect(education[0]?.statement).toContain("Design programme");
  expect(education[0]?.effectiveFrom).toBe("2018");
  expect(education[0]?.effectiveTo).toBe("2021");
  expect(education[1]?.statement).toContain("Institution unknown");
  expect(education[1]?.statement).not.toContain("Example College");
  expect(education[1]?.effectiveFrom).toBe("2015");
  expect(education[1]?.effectiveTo).toBe("2017");
  for (const item of education) {
    expect(item.status).toBe("claimed");
    expect(item.fact).toBeUndefined();
    expect(source.text).toContain(item.citations[0]?.quote);
  }
  expect(profile?.role).toBeNull();
  expect(profile?.background).toBeNull();
});

test("audit F10: omitted credentials and organization titles retain their issuers, dates and sections", async () => {
  const text =
    "Licenses & Certifications\nCustomer Experience Fellowship\nExample Institute\nIssued Oct 2022\nOrganizations\nExample Association\nCommunications Chair\nAug 2020 - Present\nLanguages\nEnglish";
  const { dossier, source, profile } = await replay(text);
  expect(dossier?.claims).toHaveLength(2);
  const certification = dossier?.claims.find((item) => item.section === "recognition");
  expect(certification?.statement).toContain("Customer Experience Fellowship — Example Institute");
  expect(certification?.statement).toContain("Issued Oct 2022");
  expect(certification?.effectiveFrom).toBe("2022-10");
  const organization = dossier?.claims.find((item) => item.section === "connections");
  expect(organization?.statement).toContain("Example Association — Communications Chair");
  expect(organization?.statement).toContain("Aug 2020 - Present");
  expect(organization?.effectiveFrom).toBe("2020-08");
  for (const item of dossier?.claims ?? []) {
    expect(item.status).toBe("claimed");
    expect(item.fact).toBeUndefined();
    expect(source.text).toContain(item.citations[0]?.quote);
  }
  expect(profile?.role).toBeNull();
  expect(profile?.currentEmployer).toBeNull();
});

const liveFixture = new URL(
  "../../../artifacts/person-profile-remediation/session2/",
  import.meta.url,
).pathname;
test.skipIf(!existsSync(join(liveFixture, "live-extraction.json")))(
  "audit F10: the retained live omission response recovers scoped entries without another provider call",
  async () => {
    const source = JSON.parse(readFileSync(join(liveFixture, "live-source.json"), "utf8")) as {
      text: string;
      url: string;
    };
    const answer: unknown = JSON.parse(
      readFileSync(join(liveFixture, "live-extraction.json"), "utf8"),
    );
    const { dossier, profile } = await replay(source.text, source.url, answer);
    const education =
      dossier?.claims.filter((item) => item.statement.startsWith("Education —")) ?? [];
    expect(education).toHaveLength(6);
    expect(education.filter((item) => item.statement.includes("Institution unknown"))).toHaveLength(
      5,
    );
    expect(education.every((item) => item.effectiveFrom && item.effectiveTo)).toBe(true);
    expect(dossier?.claims.filter((item) => item.section === "recognition")).toHaveLength(1);
    expect(dossier?.claims.filter((item) => item.section === "connections")).toHaveLength(1);
    expect(dossier?.claims).toHaveLength(11);
    expect(dossier?.claims.every((item) => item.status === "claimed")).toBe(true);
    expect(profile?.role).toBeNull();
    expect(profile?.currentEmployer).toBeNull();
  },
);

test("audit F10: structured recovery does not invent fields from unrelated pages or incomplete entries", async () => {
  const otherPage = await replay(
    "Education\nExample College\n2018 - 2021",
    "https://example.com/biography",
  );
  expect(otherPage.dossier?.claims ?? []).toHaveLength(0);
  const partial = await replay(
    "Licenses & Certifications\nExample Credential\nIssued Oct 2022\nOrganizations\nExample Association\nCommunications Chair\nLanguages\nEnglish",
  );
  expect(partial.dossier?.claims ?? []).toHaveLength(0);
});

test("audit F10: consecutive education date rows never name a previous date as an institution", async () => {
  const { dossier } = await replay("Education\n2018 - 2021\n2015 - 2017\nCourses");
  expect(dossier?.claims).toHaveLength(2);
  expect(dossier?.claims.every((item) => item.statement.includes("Institution unknown"))).toBe(
    true,
  );
  expect(dossier?.claims[1]?.citations[0]?.quote).toBe("2015 - 2017");
});

test("audit F10: structured recovery does not attribute a redirected profile to the requested person", async () => {
  const { dossier } = await replay(
    "Education\nExample College\n2018 - 2021",
    url,
    extraction,
    "https://www.linkedin.com/in/another-example/",
  );
  expect(dossier?.claims ?? []).toHaveLength(0);
});
