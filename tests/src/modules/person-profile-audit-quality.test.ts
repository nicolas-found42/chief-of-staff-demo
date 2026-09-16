import type { BrowserRenderer } from "../../../apps/server/src/source-adapters/browser.js";
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
  html?: string,
  render?: BrowserRenderer,
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
      body: html ?? asHtml(text),
    }),
    complete: async () => answer,
    ...(render ? { render } : {}),
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

test("PP-02: a title fragment cannot lead with an unsupported current association", async () => {
  const quote = "Example Labs | LinkedIn";
  const { dossier } = await replay(
    `Page title: Morgan Example - ${quote}\nAbout\nMorgan builds systems.`,
    url,
    {
      ...extraction,
      claims: [{ ...claim("title", quote), statement: "Morgan currently works at Example Labs." }],
    },
  );
  expect(dossier?.claims[0]?.statement).not.toContain("currently works");
  expect(dossier?.claims[0]?.statement).toContain(quote);
  expect(dossier?.claims[0]?.changeReason).toContain("Morgan currently works at Example Labs");
});

test("PP-02: incomplete education is one summary limitation with meaningful dated citations", async () => {
  const { dossier } = await replay(
    "Education\nExample College\n2018 - 2021\n-\n2015 - 2017\n-\n2012 - 2014\nLicenses & Certifications",
  );
  const summary = dossier?.sections.find((s) => s.key === "overview")?.summary ?? "";
  expect(summary).toContain("Example College");
  expect(summary).not.toContain("Education — Institution unknown");
  expect(summary).toContain("2 incomplete education records");
  for (const c of dossier?.claims.filter((c) => c.statement.includes("Institution unknown")) ?? [])
    expect(c.citations[0]?.quote.trim()).toMatch(/^\d{4}/);
});

test("PP-03: attributed public article cards survive capture and valid extraction omissions", async () => {
  const html = `<html><head><title>Morgan Example | LinkedIn</title></head><body><h1>Morgan Example</h1><article><p>Morgan builds systems and writes about their work.</p></article><section data-section="articles"><h2>Articles by Morgan</h2>${[1, 2, 3, 4].map((i) => `<div class="main-article-card"><a href="https://www.linkedin.com/pulse/article-${i}">Read</a><h3>Article ${i}</h3><span class="base-main-card__metadata-item">Oct 13, 2022</span></div>`).join("")}</section><aside><a href="https://linkedin.com/pulse/unrelated">Someone else's article</a></aside></body></html>`;
  const { dossier, source } = await replay("", url, extraction, url, html);
  expect(dossier?.works).toHaveLength(4);
  expect(dossier?.works.map((w) => w.title)).toEqual([
    "Article 1",
    "Article 2",
    "Article 3",
    "Article 4",
  ]);
  for (const work of dossier!.works) {
    expect(work.startedAt).toBe("2022-10-13");
    expect(work.contribution).toBeNull();
    const evidence = dossier!.claims.find((c) => c.id === work.claimIds[0])!;
    expect(evidence.statement).toContain("Morgan Example");
    expect(evidence.status).toBe("claimed");
    expect(source.text).toContain(evidence.citations[0].quote);
    expect(evidence.citations[0].quote).toContain(work.url);
  }
  expect(dossier?.sections.find((s) => s.key === "ideas")?.summary).toContain("Article 1");
  const redirected = await replay("", url, extraction, "https://linkedin.com/in/other", html);
  expect(redirected.dossier?.works ?? []).toHaveLength(0);
});
test("PP-03: an empty article section discloses capture loss without inventing work", async () => {
  const html =
    '<html><body><h1>Morgan Example</h1><article><p>Morgan builds systems and writes about their work.</p></article><section data-section="articles"><h2>Articles by Morgan</h2></section></body></html>';
  const { source, dossier } = await replay("", url, extraction, url, html);
  expect(source.provenanceNote).toContain("Article capture limitation");
  expect(dossier?.works ?? []).toEqual([]);
});

test("live remediation: profile recommendations cannot locate the subject", async () => {
  const quote = "4 others named Morgan Example in United States are on LinkedIn";
  const { dossier } = await replay(`Page title: Morgan Example | LinkedIn\n${quote}`, url, {
    ...extraction,
    claims: [{ ...claim("other", quote), statement: "Morgan is located in the United States." }],
  });
  expect(dossier?.claims ?? []).toEqual([]);
});

test("live remediation: nonprofit affiliation fragments cannot establish co-founding", async () => {
  const quote = "his nonprofit ExampleCode, which teaches coding through music remixing.";
  const { dossier } = await replay(quote, url, {
    ...extraction,
    claims: [{ ...claim("founder", quote), statement: "Morgan co-founded ExampleCode." }],
  });
  expect(dossier?.claims[0]?.statement).toContain(quote);
  expect(dossier?.claims[0]?.statement).not.toContain("co-founded");
});

test("live remediation: paraphrased recommendation fragments do not establish services", async () => {
  const quote = "as well as to individuals navigating major career transitions.";
  const { dossier } = await replay(quote, url, {
    ...extraction,
    claims: [{ ...claim("service", quote), statement: "Morgan helps people change careers." }],
  });
  expect(dossier?.claims[0]?.statement).toContain("Unresolved source fragment");
  expect(dossier?.claims[0]?.statement).toContain(quote);
});

test("live remediation: matched public profile heading resolves a name omitted by a valid model answer", async () => {
  const html =
    "<html><body><h1>Morgan Example</h1><article><p>Morgan Example builds systems and writes about their work.</p></article></body></html>";
  const { profile } = await replay("", url, extraction, url, html);
  expect(profile?.fullName).toBe("Morgan Example");
  const other = await replay("", url, extraction, "https://linkedin.com/in/other", html);
  expect(other.profile?.fullName).toBeNull();
});

test("live remediation: unresolved work mentions cannot establish contribution, authority, or dates", async () => {
  const quote = "ExampleCode";
  const { dossier } = await replay(quote, url, {
    ...extraction,
    claims: [
      { ...claim("work", quote), statement: "Morgan founded ExampleCode.", effectiveFrom: "2026" },
    ],
    works: [
      {
        id: "work",
        title: "ExampleCode",
        kind: "company",
        url,
        startedAt: "2026",
        endedAt: null,
        claimIds: ["work"],
        contribution: { text: "Founded the organization", claimIds: ["work"] },
        teamContribution: null,
        authority: [{ role: "decided", claimIds: ["work"] }],
        scale: [],
        constraints: [],
        outcomes: [],
      },
    ],
  });
  expect(dossier?.claims[0]?.effectiveFrom).toBeNull();
  expect(dossier?.works[0]).toMatchObject({
    title: "ExampleCode",
    kind: "other",
    startedAt: null,
    contribution: null,
    authority: [],
  });
  expect(dossier?.claims[0]?.statement).toContain("Unresolved source fragment");
});

test("live remediation: different background statements are not mutually exclusive facts", async () => {
  const quotes = ["Morgan built a music application.", "Morgan taught computer science."];
  const { dossier } = await replay(quotes.join("\n"), url, {
    ...extraction,
    claims: quotes.map((quote, index) => ({
      ...claim(String(index), quote),
      fact: { field: "background", value: quote },
    })),
  });
  expect(dossier?.claims).toHaveLength(2);
  expect(dossier?.claims.every((claim) => claim.status !== "contested")).toBe(true);
});

test("live remediation: an exact matched public name is an attributed heading rather than an unknown relation", async () => {
  const html =
    "<html><body><h1>Morgan Example</h1><article><p>Morgan Example builds systems and writes about their work.</p></article></body></html>";
  const { dossier } = await replay(
    "",
    url,
    {
      ...extraction,
      claims: [
        {
          ...claim("name", "Morgan Example"),
          fact: { field: "fullName", value: "Morgan Example" },
          statement: "The full name is Morgan Example.",
        },
      ],
    },
    url,
    html,
  );
  expect(dossier?.claims[0]?.statement).toBe("The public profile lists the name Morgan Example.");
  expect(dossier?.claims[0]?.citations[0]?.quote).toBe("Public profile name: Morgan Example");
});

test("live remediation: captured article metadata repairs an existing model work's unrelated citation", async () => {
  const html =
    '<html><body><h1>Morgan Example</h1><article><p>Morgan works at Example Labs.</p></article><section data-section="articles"><h2>Articles by Morgan</h2><div class="main-article-card"><a href="https://www.linkedin.com/pulse/article-1">Read</a><h3>Article 1</h3><span class="base-main-card__metadata-item">Oct 13, 2022</span></div></section></body></html>';
  const { dossier } = await replay(
    "",
    url,
    {
      ...extraction,
      claims: [claim("unrelated", "Morgan works at Example Labs.")],
      works: [
        {
          id: "model-work",
          title: "Article 1",
          kind: "post",
          url: "https://www.linkedin.com/pulse/article-1",
          startedAt: null,
          endedAt: null,
          claimIds: ["unrelated"],
          contribution: {
            text: "Argues that technology solves all problems",
            claimIds: ["unrelated"],
          },
          teamContribution: null,
          authority: [],
          scale: [],
          constraints: [],
          outcomes: [],
        },
      ],
    },
    url,
    html,
  );
  expect(dossier?.works).toHaveLength(1);
  const work = dossier!.works[0];
  expect(work).toMatchObject({ kind: "post", startedAt: "2022-10-13", contribution: null });
  const supporting = dossier!.claims.find((claim) => claim.id === work.claimIds[0])!;
  expect(supporting.citations[0]?.quote).toContain("Title: Article 1");
  expect(supporting.citations[0]?.quote).toContain("URL: https://www.linkedin.com/pulse/article-1");
  expect(dossier?.sections.find((section) => section.key === "overview")?.summary).toContain(
    "Morgan Example",
  );
});

test("live remediation: a generic program description retains the dated education context without claiming completion", async () => {
  const quote = "Example School is an industry-led night school for creatives.";
  const { dossier } = await replay(
    `Education\nExample School\n-\n2026 - 2026\n${quote} The program includes professional mentorship.`,
    url,
    {
      ...extraction,
      claims: [
        {
          ...claim("education", quote),
          statement: "Morgan participated in Example School.",
          effectiveFrom: "2026",
          effectiveTo: "2026",
        },
      ],
    },
  );
  expect(dossier?.claims).toHaveLength(1);
  const entry = dossier!.claims[0];
  expect(entry.statement).toContain("Education — Example School — 2026 - 2026");
  expect(entry.statement).not.toContain("participated");
  expect(entry.citations[0]?.quote).toContain("2026 - 2026");
  expect(entry.changeReason).not.toContain("does not establish");
  expect(entry.changeReason).toContain("no independent verification");
});

test("live remediation: credential titles repeated inside article headings still retain their unique structured context", async () => {
  const quote = "KindWork Customer Experience Fellowship";
  const { dossier } = await replay(
    `Title: ${quote} Training Recap\nLicenses & Certifications\n${quote}\nKindWork\nIssued Oct 2022`,
    url,
    {
      ...extraction,
      claims: [
        {
          ...claim("credential", quote),
          statement: "Licensed KindWork Customer Experience Fellowship",
          effectiveFrom: "2022-10",
        },
      ],
    },
  );
  expect(dossier?.claims).toHaveLength(1);
  expect(dossier?.claims[0]?.statement).toBe(
    "KindWork Customer Experience Fellowship — KindWork — Issued Oct 2022",
  );
  expect(dossier?.claims[0]?.citations[0]?.quote).toContain("Issued Oct 2022");
  expect(dossier?.claims[0]?.changeReason).not.toContain("does not establish");
});

test("review: structured fields survive an equivalent LinkedIn subdomain redirect", async () => {
  const { dossier } = await replay(
    "Education\nExample College\n2018 - 2021",
    url,
    extraction,
    "https://uk.linkedin.com/in/morgan-example/",
  );
  expect(dossier?.claims.some((claim) => claim.statement.includes("Example College"))).toBe(true);
});

test("a literal employer title remains unresolved even when the model repeats it verbatim", async () => {
  const { dossier } = await replay("Example Labs", url, {
    ...extraction,
    claims: [
      {
        ...claim("employer", "Example Labs"),
        fact: { field: "currentEmployer", value: "Example Labs" },
      },
    ],
  });
  expect(dossier?.claims[0]?.statement).toContain("Unresolved source fragment");
});

test("PP-03: public browser metadata supplements cards absent from the anonymous HTTP response", async () => {
  const html = (count: number) =>
    `<html><body><h1>Morgan Example</h1><article><p>Morgan builds systems and writes about their work.</p></article><section data-section="articles"><h2>Articles by Morgan</h2>${Array.from({ length: count }, (_, i) => `<div class="main-article-card"><a href="https://www.linkedin.com/pulse/article-${i}">Read</a><h3>Article ${i}</h3><span class="base-main-card__metadata-item">Oct 13, 2022</span></div>`).join("")}</section></body></html>`;
  let calls = 0;
  const { dossier, source } = await replay("", url, extraction, url, html(3), async (target) => {
    // The operation may follow article links; those are unavailable in this fixture.
    if (target.replace(/\/$/, "") !== url.replace(/\/$/, ""))
      return { url: target, status: 404, contentType: "text/html", body: "" };
    calls++;
    return { url, status: 200, contentType: "text/html", body: html(4) };
  });
  expect(calls).toBe(1);
  expect(dossier?.works).toHaveLength(4);
  expect(source.provenanceNote).toContain("1 additional");
  expect(source.provenanceNote).toContain("4 article records");
  expect(source.text).toContain("Morgan builds systems");
  const blocked = await replay("", url, extraction, url, html(3), async () => ({
    url,
    status: 999,
    contentType: "text/html",
    body: html(4),
  }));
  expect(blocked.dossier?.works).toHaveLength(3);
  expect(blocked.source.provenanceNote).toContain("could not be verified");
  const redirected = await replay("", url, extraction, url, html(3), async () => ({
    url: "https://linkedin.com/in/someone-else",
    status: 200,
    contentType: "text/html",
    body: html(4),
  }));
  expect(redirected.dossier?.works).toHaveLength(3);
});
