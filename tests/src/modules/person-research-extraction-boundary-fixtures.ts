import { fromPartial } from "@total-typescript/shoehorn";
import type { PersonProfile } from "@chief-of-staff-demo/shared";
import type { Extraction } from "../../../apps/server/src/person-profile/extraction-parts.js";

/**
 * Fictional, non-sensitive boundary fixtures for the Extraction result shape
 * (#418 spec §3). No person, organisation, URL or quote below refers to a
 * real one; every fixture is invented to carry the *shape* of a structural
 * obligation the shape must satisfy, not any real research finding. Follows
 * the pattern documented in
 * `tests/src/modules/person-research-subject-attribution.test.ts:18-30`.
 *
 * Five cases, one per spec §3 bullet:
 *  - `denseMultiClaim`     — a full-shape part: claims, a work, expertise, a
 *                            connection and sections, all cross-referenced.
 *  - `sparseIdentityOnly`  — only the identity/source-metadata fields; no
 *                            claims or dossier structure at all.
 *  - `noRelevantFacts`     — a legitimate validated *empty* Extraction: valid
 *                            per `ExtractionSchema`, distinguishable from "the
 *                            model returned no answer" only by existing.
 *  - `duplicateLocalIds`   — two independently-produced parts that each
 *                            invent the same local claim/work id, so any
 *                            consumer can prove the ids collide before a
 *                            part-prefixing step runs.
 *  - `wrongSubject`        — the ADR-0097 case: a document that declares a
 *                            different person as its subject in its opening
 *                            lines but still names the fixture's subject in
 *                            one sentence, exercising `declaresOtherSubject`
 *                            and `claimNamesSubject`.
 *
 * Every citation `quote` below is a verbatim substring of its fixture's
 * `documentText` — `parsePartial` and `replayGrounded` both filter on
 * `text.includes(quote)`, so a fixture whose quotes do not literally appear
 * would be silently useless to anything that consumes it.
 */

type ClaimRecord = Extraction["claims"][number];
type WorkRecord = Extraction["works"][number];
type SectionRecord = Extraction["sections"][number];

function claim(input: {
  id: string;
  section: ClaimRecord["section"];
  statement: string;
  quote: string;
  fact?: NonNullable<ClaimRecord["fact"]>;
  status?: ClaimRecord["status"];
}): ClaimRecord {
  return {
    id: input.id,
    section: input.section,
    statement: input.statement,
    ...(input.fact ? { fact: input.fact } : {}),
    status: input.status ?? "supported",
    nature: "statement",
    matchConfidence: "high",
    effectiveFrom: null,
    effectiveTo: null,
    citations: [{ sourceId: "source", quote: input.quote }],
    supports: [],
    supersedes: [],
    changeReason: null,
  };
}

function work(input: {
  id: string;
  title: string;
  kind: WorkRecord["kind"];
  claimIds: string[];
  url?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  contribution?: WorkRecord["contribution"];
  authority?: WorkRecord["authority"];
  scale?: WorkRecord["scale"];
  outcomes?: WorkRecord["outcomes"];
}): WorkRecord {
  return {
    id: input.id,
    title: input.title,
    url: input.url ?? null,
    kind: input.kind,
    startedAt: input.startedAt ?? null,
    endedAt: input.endedAt ?? null,
    claimIds: input.claimIds,
    contribution: input.contribution ?? null,
    teamContribution: null,
    authority: input.authority ?? [],
    scale: input.scale ?? [],
    constraints: [],
    outcomes: input.outcomes ?? [],
  };
}

function extraction(input: {
  sourceClass: Extraction["sourceClass"];
  fullName?: string | null;
  employer?: string | null;
  author?: string | null;
  publishedAt?: string | null;
  claims?: Extraction["claims"];
  works?: Extraction["works"];
  expertise?: Extraction["expertise"];
  connections?: Extraction["connections"];
  sections?: Extraction["sections"];
}): Extraction {
  return {
    fullName: input.fullName ?? null,
    employer: input.employer ?? null,
    sourceClass: input.sourceClass,
    author: input.author ?? null,
    publishedAt: input.publishedAt ?? null,
    claims: input.claims ?? [],
    works: input.works ?? [],
    expertise: input.expertise ?? [],
    connections: input.connections ?? [],
    sections: input.sections ?? [],
  };
}

// ---------------------------------------------------------------------------
// 1. Dense multi-claim part
// ---------------------------------------------------------------------------

const DENSE_DOCUMENT = [
  "Dana Okonkwo is a systems engineer at Vellum Robotics, a logistics automation company based in Turable City. ",
  "Okonkwo joined Vellum Robotics in 2019 as a senior engineer and was promoted to Director of Autonomy in 2021. ",
  "Okonkwo led the Harrow Loop project, an autonomous warehouse routing system deployed across 12 depots in 2022. ",
  "Okonkwo personally decided the routing algorithm's fallback behavior after a depot outage in 2022. ",
  "The Harrow Loop project reduced average pick time by 18 percent across those depots in 2022. ",
  "Okonkwo has described distributed consensus as the hardest unsolved problem in warehouse robotics. ",
  "Okonkwo has collaborated with Researcher Lior Amsel on the Harrow Loop project since 2020. ",
  "Okonkwo serves on the advisory board of the Turable Robotics Guild since 2023.",
].join("");

const denseEmployerClaim = claim({
  id: "employer-role",
  section: "career",
  statement: "Okonkwo is a Director of Autonomy at Vellum Robotics.",
  quote:
    "Okonkwo joined Vellum Robotics in 2019 as a senior engineer and was promoted to Director of Autonomy in 2021.",
  fact: { field: "currentEmployer", value: "Vellum Robotics" },
});
const denseLedClaim = claim({
  id: "harrow-loop-led",
  section: "work",
  statement: "Okonkwo led the Harrow Loop project, an autonomous warehouse routing system.",
  quote:
    "Okonkwo led the Harrow Loop project, an autonomous warehouse routing system deployed across 12 depots in 2022.",
});
const denseDecisionClaim = claim({
  id: "harrow-loop-decision",
  section: "work",
  statement:
    "Okonkwo personally decided the routing algorithm's fallback behavior after a depot outage in 2022.",
  quote:
    "Okonkwo personally decided the routing algorithm's fallback behavior after a depot outage in 2022.",
});
const denseOutcomeClaim = claim({
  id: "harrow-loop-outcome",
  section: "work",
  statement:
    "The Harrow Loop project reduced average pick time by 18 percent across those depots in 2022.",
  quote:
    "The Harrow Loop project reduced average pick time by 18 percent across those depots in 2022.",
});
const denseExpertiseClaim = claim({
  id: "expertise-consensus",
  section: "expertise",
  statement:
    "Okonkwo has described distributed consensus as the hardest unsolved problem in warehouse robotics.",
  quote:
    "Okonkwo has described distributed consensus as the hardest unsolved problem in warehouse robotics.",
});
const denseConnectionClaim = claim({
  id: "connection-amsel",
  section: "connections",
  statement: "Okonkwo has collaborated with Lior Amsel on the Harrow Loop project since 2020.",
  quote:
    "Okonkwo has collaborated with Researcher Lior Amsel on the Harrow Loop project since 2020.",
});
const denseRecognitionClaim = claim({
  id: "recognition-guild",
  section: "recognition",
  statement: "Okonkwo serves on the advisory board of the Turable Robotics Guild since 2023.",
  quote: "Okonkwo serves on the advisory board of the Turable Robotics Guild since 2023.",
});

const denseWork = work({
  id: "harrow-loop",
  title: "Harrow Loop",
  url: "https://vellum-robotics.example.test/harrow-loop",
  kind: "system",
  startedAt: "2022",
  claimIds: [denseLedClaim.id, denseDecisionClaim.id, denseOutcomeClaim.id],
  contribution: {
    text: "Okonkwo personally decided the routing algorithm's fallback behavior after a depot outage in 2022.",
    claimIds: [denseDecisionClaim.id],
  },
  authority: [{ role: "decided", claimIds: [denseDecisionClaim.id] }],
  scale: [
    {
      value: 18,
      unit: "percent",
      scope: "average pick time reduction across 12 depots",
      date: "2022",
      claimIds: [denseOutcomeClaim.id],
    },
  ],
  outcomes: [
    {
      text: "The Harrow Loop project reduced average pick time by 18 percent across those depots in 2022.",
      claimIds: [denseOutcomeClaim.id],
      date: "2022",
      afterDeparture: false,
      unsuccessful: false,
    },
  ],
});

const denseSections: SectionRecord[] = [
  {
    key: "work",
    summary: "Led the Harrow Loop autonomous routing project at Vellum Robotics.",
    claimIds: [denseLedClaim.id, denseDecisionClaim.id, denseOutcomeClaim.id],
    updatedAt: null,
    gaps: [],
    state: "current",
  },
  {
    key: "recognition",
    summary: "Serves on the Turable Robotics Guild advisory board.",
    claimIds: [denseRecognitionClaim.id],
    updatedAt: null,
    gaps: [],
    state: "current",
  },
];

export const denseMultiClaim: { documentText: string; extraction: Extraction } = {
  documentText: DENSE_DOCUMENT,
  extraction: extraction({
    sourceClass: "independent-account",
    fullName: "Dana Okonkwo",
    employer: "Vellum Robotics",
    author: "Turable Business Journal",
    publishedAt: "2023-11-02",
    claims: [
      denseEmployerClaim,
      denseLedClaim,
      denseDecisionClaim,
      denseOutcomeClaim,
      denseExpertiseClaim,
      denseConnectionClaim,
      denseRecognitionClaim,
    ],
    works: [denseWork],
    expertise: [
      {
        category: "Distributed systems",
        originalWording:
          "distributed consensus as the hardest unsolved problem in warehouse robotics",
        support: "claimed",
        workIds: [],
        claimIds: [denseExpertiseClaim.id],
      },
    ],
    connections: [
      {
        id: "connection-amsel-record",
        counterparty: "Lior Amsel",
        profileId: null,
        kind: "collaborated",
        direction: "undirected",
        from: "2020",
        to: null,
        workIds: [denseWork.id],
        claimIds: [denseConnectionClaim.id],
      },
    ],
    sections: denseSections,
  }),
};

// ---------------------------------------------------------------------------
// 2. Sparse identity-only material
// ---------------------------------------------------------------------------

export const sparseIdentityOnly: { documentText: string; extraction: Extraction } = {
  documentText: [
    "Turable Robotics Forum -- 2024 Program\n",
    "Speaker: Dana Okonkwo, Vellum Robotics.\n",
    "Compiled by the Forum Programming Committee.\n",
    "Published 2024-03-01.",
  ].join(""),
  extraction: extraction({
    sourceClass: "primary-artifact",
    fullName: "Dana Okonkwo",
    employer: "Vellum Robotics",
    author: "Forum Programming Committee",
    publishedAt: "2024-03-01",
  }),
};

// ---------------------------------------------------------------------------
// 3. No relevant facts — a legitimate validated empty Extraction
// ---------------------------------------------------------------------------

export const noRelevantFacts: { documentText: string; extraction: Extraction } = {
  documentText:
    "Vellum Robotics Facilities Notice: The east parking structure will be closed for " +
    "maintenance from June 1 to June 5. Contact facilities@vellum-robotics.example for details.",
  extraction: extraction({
    sourceClass: "primary-artifact",
  }),
};

// ---------------------------------------------------------------------------
// 4. Cross-part duplicate local IDs
// ---------------------------------------------------------------------------

const DUPLICATE_ID_PART_A_DOCUMENT =
  "Dana Okonkwo joined Vellum Robotics in 2019 as a senior engineer.";
const DUPLICATE_ID_PART_B_DOCUMENT =
  "Okonkwo received the Turable Innovation Prize in 2021 for the Harrow Loop project.";

/** The local id both independently-extracted parts happen to invent. */
export const DUPLICATE_LOCAL_CLAIM_ID = "c1";
export const DUPLICATE_LOCAL_WORK_ID = "w1";

const duplicateIdPartAClaim = claim({
  id: DUPLICATE_LOCAL_CLAIM_ID,
  section: "career",
  statement: "Okonkwo joined Vellum Robotics in 2019 as a senior engineer.",
  quote: "Dana Okonkwo joined Vellum Robotics in 2019 as a senior engineer.",
});
const duplicateIdPartBClaim = claim({
  id: DUPLICATE_LOCAL_CLAIM_ID,
  section: "recognition",
  statement: "Okonkwo received the Turable Innovation Prize in 2021 for the Harrow Loop project.",
  quote: "Okonkwo received the Turable Innovation Prize in 2021 for the Harrow Loop project.",
});

export const duplicateLocalIds: {
  partA: { documentText: string; extraction: Extraction };
  partB: { documentText: string; extraction: Extraction };
} = {
  partA: {
    documentText: DUPLICATE_ID_PART_A_DOCUMENT,
    extraction: extraction({
      sourceClass: "independent-account",
      claims: [duplicateIdPartAClaim],
      works: [
        work({
          id: DUPLICATE_LOCAL_WORK_ID,
          title: "Vellum Robotics tenure",
          kind: "company",
          startedAt: "2019",
          claimIds: [duplicateIdPartAClaim.id],
        }),
      ],
    }),
  },
  partB: {
    documentText: DUPLICATE_ID_PART_B_DOCUMENT,
    extraction: extraction({
      sourceClass: "independent-account",
      claims: [duplicateIdPartBClaim],
      works: [
        work({
          id: DUPLICATE_LOCAL_WORK_ID,
          title: "Turable Innovation Prize",
          kind: "other",
          startedAt: "2021",
          endedAt: "2021",
          claimIds: [duplicateIdPartBClaim.id],
        }),
      ],
    }),
  },
};

// ---------------------------------------------------------------------------
// 5. A document that mentions the subject but is about another person
//    (ADR-0097 / `declaresOtherSubject` + `claimNamesSubject`)
// ---------------------------------------------------------------------------

/**
 * The fixture's subject Profile. Only `fullName` is read by
 * `declaresOtherSubject`/`claimNamesSubject`; the rest of `PersonProfile` is
 * irrelevant to this fixture and left absent via `fromPartial`.
 */
export const wrongSubjectProfile: PersonProfile = fromPartial<PersonProfile>({
  fullName: "Dana Okonkwo",
  currentEmployer: "Vellum Robotics",
});

/**
 * A retained encyclopedia-style article about a different, entirely
 * fictional individual (Talia Reznick) who shares the fixture subject's
 * employer and, in one sentence, worked alongside them. The lead-in and
 * infobox block before the declaration reproduce the shape the retained
 * #409 evidence was measured against: the declaration sits a few hundred
 * characters in, at the start of a line, behind exactly that furniture.
 */
export const wrongSubjectDocument = [
  "From the open technical archive\n\t\t\t\t\t\n",
  "Talia ReznickBorn1988 (age 37-38)PortcullionOccupationRobotics engineer",
  "Notable workGantry Line control software (2016)",
  "AwardsPortcullion Engineering Medal (2016)Websitewww.example-talia.test\n",
  "Talia Reznick is a Portcullion-based robotics engineer at Vellum Robotics.",
  " She designed the Gantry Line control software in 2016.",
  " In 2022 Reznick worked alongside Dana Okonkwo on the Harrow Loop rollout at Vellum Robotics.",
  " Reznick later became the lead safety engineer for the Gantry Line in 2023.",
].join("");

const wrongSubjectOwnWorkClaim = claim({
  id: "reznick-own-work",
  section: "work",
  statement: "Reznick designed the Gantry Line control software in 2016.",
  quote: "She designed the Gantry Line control software in 2016.",
});
const wrongSubjectCollaborationClaim = claim({
  id: "reznick-collab-okonkwo",
  section: "connections",
  statement: "In 2022 Reznick worked alongside Dana Okonkwo on the Harrow Loop rollout.",
  quote:
    "In 2022 Reznick worked alongside Dana Okonkwo on the Harrow Loop rollout at Vellum Robotics.",
});
const wrongSubjectOwnRoleClaim = claim({
  id: "reznick-own-role",
  section: "career",
  statement: "Reznick later became the lead safety engineer for the Gantry Line in 2023.",
  quote: "Reznick later became the lead safety engineer for the Gantry Line in 2023.",
});

/**
 * The raw per-part Extraction as a model might answer for this document,
 * before ADR-0097's per-claim subject filter runs (`parsePartial` applies
 * that filter; this fixture only supplies its input and expected outcome).
 */
export const wrongSubjectExtraction: Extraction = extraction({
  sourceClass: "independent-account",
  claims: [wrongSubjectOwnWorkClaim, wrongSubjectCollaborationClaim, wrongSubjectOwnRoleClaim],
});

/** Claims whose cited sentence names the subject: admitted despite the document being about someone else. */
export const wrongSubjectAdmittedClaimIds: string[] = [wrongSubjectCollaborationClaim.id];

/** Claims genuinely about the declared other subject: must be withheld, never silently dropped. */
export const wrongSubjectWithheldClaimIds: string[] = [
  wrongSubjectOwnWorkClaim.id,
  wrongSubjectOwnRoleClaim.id,
];
