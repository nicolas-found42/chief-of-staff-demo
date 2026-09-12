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

/* Entirely fictional documents. No person, organisation or claim below refers
   to a real one; they carry the shape of the measured failure on #409, not its
   content. The real replay is the last test in this file.

   The shape: a document about a different named individual that mentions the
   subject once, and names the subject's employer because the two people share
   it. Name plus employer is a `matched` identity for the document, and the
   off-subject claims are verbatim, so neither the identity decision nor the
   grounding check refuses them.

   The lead-in and the infobox block before the declaration are part of the
   shape too: a retained encyclopedia article puts its first sentence a few
   hundred characters in, behind exactly that furniture. */
const OTHER_PERSON_PAGE = [
  "From the free encyclopedia\n\t\t\t\t\t\n",
  "Wren HalloranBorn1994 (age 31-32)NorthmarchOccupationChoreographer",
  "Notable workRiver Signal (2018 music video) choreography",
  "AwardsNorthmarch Stage Award for Best Choreography (2018)Websitewww.example.com\n",
  "Wren Halloran is a Northmarch-born choreographer and dancer.",
  " She choreographed the River Signal music video in 2018.",
  " In 2019 the Meridian Health Council appointed her a Goodwill Ambassador,",
  " an appointment announced by Ilse Vantyne.",
].join("");

const claim = (id: string, statement: string, quote: string) => ({
  id,
  section: "overview" as const,
  statement,
  status: "supported" as const,
  nature: "statement" as const,
  matchConfidence: "high" as const,
  effectiveFrom: null,
  effectiveTo: null,
  citations: [{ sourceId: "source", quote }],
  supports: [],
  supersedes: [],
  changeReason: null,
});

const extraction = (claims: ReturnType<typeof claim>[]) => ({
  fullName: null,
  employer: null,
  sourceClass: "independent-account" as const,
  author: null,
  publishedAt: null,
  claims,
  works: [],
  expertise: [],
  connections: [],
  sections: [],
});

test("a document about a different individual publishes no claim about that individual", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-subject-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({
    fullName: "Ilse Vantyne",
    currentEmployer: "Meridian Health Council",
  });
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [
      { url: "https://example.com/wren-halloran", title: "Wren Halloran", snippet: "" },
    ],
    fetch: async (url) => ({
      url,
      status: url === "https://example.com/wren-halloran" ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url === "https://example.com/wren-halloran" ? OTHER_PERSON_PAGE : "",
    }),
    complete: async () =>
      extraction([
        claim(
          "dancer",
          "Wren Halloran is a Northmarch-born choreographer.",
          "Wren Halloran is a Northmarch-born choreographer and dancer.",
        ),
        claim(
          "choreography",
          "Choreographed River Signal music video (2018)",
          "She choreographed the River Signal music video in 2018.",
        ),
      ]),
  });

  const outcome = await research.run(
    person,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }),
  );

  const statements = (dossiers.get(person.id)?.claims ?? []).map((entry) => entry.statement);
  expect(statements).toEqual([]);
  /* Withheld, never silently dropped: the operation says which claim it
     refused and why. */
  expect(outcome.operation.attempts).toContainEqual(
    expect.objectContaining({
      stage: "extraction",
      code: "off-subject-claim",
      target: "https://example.com/wren-halloran",
    }),
  );
});

/* The gate must not cost recall: a document that is about the subject
   describes them pronominally after naming them once, and those claims are
   exactly what research is for. */
const SUBJECT_PAGE = [
  "Ilse Vantyne is a Meridian public health official.",
  "She was appointed Director-General of the Meridian Health Council in 2017.",
].join(" ");

test("a pronominal claim in a document about the subject still publishes", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-subject-recall-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({
    fullName: "Ilse Vantyne",
    currentEmployer: "Meridian Health Council",
  });
  const dossiers = new PersonDossierStore(root);
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [{ url: "https://example.com/vantyne", title: "Vantyne", snippet: "" }],
    fetch: async (url) => ({
      url,
      status: url === "https://example.com/vantyne" ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url === "https://example.com/vantyne" ? SUBJECT_PAGE : "",
    }),
    complete: async () =>
      extraction([
        claim(
          "appointment",
          "Appointed Director-General of the Meridian Health Council in 2017.",
          "She was appointed Director-General of the Meridian Health Council in 2017.",
        ),
      ]),
  });

  const outcome = await research.run(
    person,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }),
  );

  expect((dossiers.get(person.id)?.claims ?? []).map((entry) => entry.statement)).toEqual([
    "Appointed Director-General of the Meridian Health Council in 2017.",
  ]);
  expect(outcome.operation.attempts.map((attempt) => attempt.code)).not.toContain(
    "off-subject-claim",
  );
});

/* A document the Profile itself names is anchored by a signal, not by a name
   match, so the gate never runs against it: whatever such a document says is
   attributed as it was before. */
test("a document anchored by the Profile's own email is unaffected", async () => {
  const root = mkdtempSync(join(tmpdir(), "research-subject-anchor-"));
  roots.push(root);
  const people = new WorkspacePersonProfiles({
    store: new PersonProfileStore(root),
    lifecycle: [],
  });
  const person = people.create({
    fullName: "Ilse Vantyne",
    primaryEmail: "vantyne@example.com",
  });
  const dossiers = new PersonDossierStore(root);
  const page = `${OTHER_PERSON_PAGE} Write to vantyne@example.com.`;
  const research = new PersonResearch({
    people,
    dossiers,
    search: async () => [{ url: "https://example.com/page", title: "Wren Halloran", snippet: "" }],
    fetch: async (url) => ({
      url,
      status: url === "https://example.com/page" ? 200 : 404,
      contentType: "text/plain",
      etag: null,
      lastModified: null,
      retryAfter: null,
      body: url === "https://example.com/page" ? page : "",
    }),
    complete: async () =>
      extraction([
        claim(
          "dancer",
          "Wren Halloran is a Northmarch-born choreographer.",
          "Wren Halloran is a Northmarch-born choreographer and dancer.",
        ),
      ]),
  });

  const outcome = await research.run(
    person,
    researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }),
  );

  expect((dossiers.get(person.id)?.claims ?? []).map((entry) => entry.statement)).toEqual([
    "Wren Halloran is a Northmarch-born choreographer.",
  ]);
  expect(outcome.operation.attempts.map((attempt) => attempt.code)).not.toContain(
    "off-subject-claim",
  );
});

/* The measured failure itself, replayed against the retained evidence on the
   machine that measured it rather than against a reduction of it.

   Every subdirectory of `artifacts/person-benchmark` is gitignored — retained
   Person Source
   Documents are not committed — so this test runs where the evidence is
   present and skips where it is not. The three tests above carry the same
   behaviour in fictional form and always run.
   - The document is the retained Sherrie Silver article that the Tedros
     dossier cited (`artifacts/person-benchmark/.../person-source-documents`).
   - The claims are the ones the judge recorded as `wrong-person` overclaims
     in that dossier, with their own recorded quotes, plus the two claims from
     the same document that really are about Tedros.
   The 2026-09-11 run's own bytes are not retained in the repo; this is the
   same article, and every recorded quote is verbatim in it. */
const RETAINED_SOURCE = join(
  import.meta.dirname,
  "../../..",
  "artifacts/person-benchmark/reader-fixed-expanded-2026-09-06/" +
    "live-discovery-expanded-09cbcaad3a1bafe8.evidence/person-source-documents/" +
    "7d5c579c63ca8fef88e149891e5ce62673a58b8bbe651421a695179824e719d2.json",
);

const WRONG_PERSON = [
  ["name", "Sherrie Silver", "Sherrie Silver"],
  ["origin", "Rwandan-born British", "Sherrie Silver is a Rwandan-born British choreographer"],
  [
    "choreography",
    "Choreographed This Is America music video (2018)",
    "choreographed the music video for Childish Gambino's 2018 song This Is America",
  ],
  [
    "award",
    "MTV Video Music Award for Best Choreography (2018)",
    "MTV Video Music Award for Best Choreography (2018)",
  ],
  [
    "ifad",
    "IFAD Youth Advocate (appointed 2019)",
    "announced that Silver was appointed as an Advocate for Rural Youth",
  ],
  [
    "father",
    "Father killed in Genocide against the Tutsi",
    "one month after her father was killed in the Genocide against the Tutsi",
  ],
  [
    "london",
    "Moved to London at age five",
    "Silver and her mother moved to London, England when she was aged five-years",
  ],
  [
    "university",
    "Business and marketing at university",
    "Silver studied business and marketing at university",
  ],
  ["mother", "Mother Florence Silver", "born in 1994 to mother Florence Silver"],
  ["pope", "Met Pope Francis (2019)", "met Pope Francis in 2019"],
] as const;

const ABOUT_SUBJECT = [
  [
    "role",
    "Tedros Adhanom Ghebreyesus is Director-General of the World Health Organization.",
    "World Health Organization Director-General Tedros Adhanom Ghebreyesus",
  ],
  [
    "lesson",
    "In 2023, Tedros Adhanom Ghebreyesus received a dance lesson from choreographer Sherrie Silver.",
    "In 2023, Silver gave a dance lesson to World Health Organization Director-General Tedros Adhanom Ghebreyesus.",
  ],
] as const;

test.skipIf(!existsSync(RETAINED_SOURCE))(
  "replaying the retained article withholds every recorded wrong-person claim and keeps the rest",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "research-subject-replay-"));
    roots.push(root);
    const retained = JSON.parse(readFileSync(RETAINED_SOURCE, "utf8")) as {
      text: string;
      url: string;
    };
    const people = new WorkspacePersonProfiles({
      store: new PersonProfileStore(root),
      lifecycle: [],
    });
    const person = people.create({
      fullName: "Tedros Adhanom Ghebreyesus",
      currentEmployer: "World Health Organization",
    });
    const dossiers = new PersonDossierStore(root);
    const research = new PersonResearch({
      people,
      dossiers,
      search: async () => [{ url: retained.url, title: "Sherrie Silver", snippet: "" }],
      fetch: async (url) => ({
        url,
        status: url === retained.url ? 200 : 404,
        contentType: "text/plain",
        etag: null,
        lastModified: null,
        retryAfter: null,
        body: url === retained.url ? retained.text : "",
      }),
      complete: async () =>
        extraction(
          [...WRONG_PERSON, ...ABOUT_SUBJECT].map(([id, statement, quote]) =>
            claim(id, statement, quote),
          ),
        ),
    });

    const outcome = await research.run(
      person,
      researchAllowance({ maxModelCalls: 3, maxMilliseconds: 10000 }),
    );

    const published = (dossiers.get(person.id)?.claims ?? []).map((entry) => entry.statement);
    expect(published.sort()).toEqual([...ABOUT_SUBJECT.map(([, statement]) => statement)].sort());
    expect(
      outcome.operation.attempts.filter((attempt) => attempt.code === "off-subject-claim"),
    ).toHaveLength(WRONG_PERSON.length);
  },
);
