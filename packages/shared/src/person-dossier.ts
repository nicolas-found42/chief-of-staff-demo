import { z } from "zod";

const text = z.string().min(1).max(4000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,160}$/);
const date = z.string().max(40).nullable();
export const PersonDossierSectionSchema = z.enum([
  "overview",
  "career",
  "work",
  "expertise",
  "ideas",
  "connections",
  "recognition",
  "context",
]);
export const PersonSourceDocumentSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  url: z.string().max(4000),
  title: text,
  author: z.string().max(1000).nullable(),
  publishedAt: date,
  retrievedAt: z.string().max(40),
  text: z.string().max(500000),
  hash: z.string().length(64),
  family: text,
  sourceClass: z.enum([
    "self-report",
    "independent-account",
    "primary-artifact",
    "workspace",
    "manual",
    "unclassified",
  ]),
  attribution: z
    .enum(["self-report", "independent-account", "primary-artifact", "unknown"])
    .optional(),
  visibility: z.enum(["public", "private"]),
  extractionCoverage: z.enum(["unattempted", "partial", "full"]).optional(),
  completeness: z.enum(["full", "partial", "snippet", "unavailable"]),
  access: z.enum(["retrieved", "blocked", "failed", "unsupported"]),
  acquisition: text,
  transcriptId: id.optional(),
  outboundUrls: z.array(z.string().max(4000)).max(200).optional(),
});
const citation = z.object({ sourceId: id, quote: text });
export const PersonClaimSchema = z.object({
  id,
  section: PersonDossierSectionSchema,
  statement: text,
  fact: z
    .object({ field: z.enum(["fullName", "role", "currentEmployer", "background"]), value: text })
    .optional(),
  status: z.enum(["supported", "claimed", "contested", "unknown", "stale", "superseded"]),
  nature: z.enum(["statement", "interpretation"]),
  matchConfidence: z.enum(["high", "medium", "low"]),
  effectiveFrom: date,
  effectiveTo: date,
  citations: z.array(citation).max(30),
  supports: z.array(id).max(30),
  supersedes: z.array(id).max(30),
  changeReason: z.string().max(4000).nullable(),
});
const grounded = z.object({ text, claimIds: z.array(id).min(1).max(30) });
export const PersonWorkRecordSchema = z.object({
  id,
  title: text,
  url: z.string().max(4000).nullable(),
  kind: z.enum([
    "system",
    "product",
    "company",
    "research",
    "paper",
    "talk",
    "patent",
    "post",
    "release",
    "commit",
    "filing",
    "other",
  ]),
  startedAt: date,
  endedAt: date,
  claimIds: z.array(id).min(1).max(30),
  contribution: grounded.nullable(),
  teamContribution: grounded.nullable(),
  authority: z
    .array(
      z.object({
        role: z.enum(["decided", "recommended", "executed"]),
        claimIds: z.array(id).min(1).max(30),
      }),
    )
    .max(10),
  scale: z
    .array(
      z.object({
        value: z.number().finite(),
        unit: text,
        scope: text,
        date,
        claimIds: z.array(id).min(1).max(30),
      }),
    )
    .max(30),
  constraints: z.array(grounded).max(30),
  outcomes: z
    .array(grounded.extend({ date, afterDeparture: z.boolean(), unsuccessful: z.boolean() }))
    .max(30),
});
export const PersonConnectionSchema = z.object({
  id,
  counterparty: text,
  counterpartyUrl: z.string().url().max(4000).optional(),
  profileId: id.nullable(),
  kind: z.enum([
    "co-authored",
    "co-founded",
    "collaborated",
    "reported-to",
    "managed",
    "shared-employer",
    "invested",
    "funded",
    "board",
    "advised",
    "committee",
    "credited",
    "influenced",
  ]),
  direction: z.enum(["outgoing", "incoming", "undirected"]),
  from: date,
  to: date,
  workIds: z.array(id).max(100),
  claimIds: z.array(id).min(1).max(30),
});
export const PersonExpertiseSchema = z.object({
  category: text,
  originalWording: text,
  support: z.enum(["claimed", "demonstrated"]),
  workIds: z.array(id).max(100),
  claimIds: z.array(id).min(1).max(30),
});
export const PersonDossierContentSchema = z.object({
  sourceIds: z.array(id).max(1000).optional(),
  claims: z.array(PersonClaimSchema).max(2000),
  works: z.array(PersonWorkRecordSchema).max(500),
  expertise: z.array(PersonExpertiseSchema).max(200),
  connections: z.array(PersonConnectionSchema).max(1000),
  sections: z
    .array(
      z.object({
        key: PersonDossierSectionSchema,
        summary: z.string().max(8000),
        claimIds: z.array(id).max(100),
        updatedAt: date,
        gaps: z.array(text).max(30),
        state: z.enum(["unresearched", "incomplete", "current", "unavailable"]),
      }),
    )
    .max(8),
});
/**
 * A published dossier. `sourceIds` loses its optionality here: publishing
 * derives the list from the content's own citations, so a stored dossier always
 * names every source it retains, and readers never have to guess whether an
 * absent list means "no sources" or "not recorded".
 */
export const PersonDossierSchema = PersonDossierContentSchema.extend({
  sourceIds: z.array(id).max(1000),
  schemaVersion: z.literal(1),
  profileId: id,
  revision: z.number().int().positive(),
  updatedAt: z.string(),
});
export type PersonSourceDocument = z.infer<typeof PersonSourceDocumentSchema>;
export type PersonClaim = z.infer<typeof PersonClaimSchema>;
export type PersonDossierContent = z.infer<typeof PersonDossierContentSchema>;
export type PersonDossier = z.infer<typeof PersonDossierSchema>;
export const PersonResearchSettingsSchema = z.object({
  paused: z.boolean(),
  concurrency: z.number().int().min(1).max(4),
  profileCalls: z.number().int().min(1).max(100),
  profileMilliseconds: z.number().int().min(1000).max(600000),
  dailyCalls: z.number().int().min(1).max(10000),
  refreshHours: z.number().min(1).max(8760),
  historicalRefreshHours: z.number().min(24).max(8760).optional(),
});
export type PersonResearchSettings = z.infer<typeof PersonResearchSettingsSchema>;
const researchResult = z.object({
  url: z.string().max(4000),
  title: z.string().max(4000),
  snippet: z.string().max(10000),
});
export const PersonResearchCheckpointSchema = z.object({
  queries: z.array(z.string().max(4000)).max(4),
  pass: z.number().int().min(0).max(4),
  results: z.array(researchResult).max(8),
  direct: z.array(researchResult).max(40),
  visited: z.array(z.string().max(4000)).max(40),
  linked: z.array(z.string().max(4000)).max(40),
  pendingSourceId: id.optional(),
});
export type PersonResearchCheckpoint = z.infer<typeof PersonResearchCheckpointSchema>;
export const PersonResearchJobSchema = z.object({
  diagnostics: z
    .array(z.object({ url: z.string(), stage: z.string(), reason: z.string() }))
    .max(100)
    .optional(),
  evidenceRevision: z.string().optional(),
  lastHistoricalAt: z.string().optional(),
  checkpoint: PersonResearchCheckpointSchema.optional(),
  elapsedMilliseconds: z.number().nonnegative().optional(),
  startedAt: z.string().optional(),
  profileId: z.string(),
  state: z.enum([
    "queued",
    "researching",
    "paused",
    "incomplete",
    "unavailable",
    "empty",
    "current",
  ]),
  reasons: z.array(z.string()),
  queuedAt: z.string(),
  updatedAt: z.string(),
  nextAt: z.string(),
  calls: z.number().int().nonnegative(),
  sources: z.number().int().nonnegative(),
  attempts: z.number().int().nonnegative(),
  detail: z.string(),
});
export type PersonResearchJob = z.infer<typeof PersonResearchJobSchema>;
export const PersonResearchStatusSchema = z.object({
  schemaVersion: z.literal(1),
  settings: PersonResearchSettingsSchema,
  day: z.string(),
  usedCalls: z.number().int().nonnegative(),
  jobs: z.array(PersonResearchJobSchema),
});
export type PersonResearchStatus = z.infer<typeof PersonResearchStatusSchema>;
export interface PersonRelationshipRecord {
  kind: "meeting" | "transcript" | "task" | "action-item";
  id: string;
  title: string;
  date: string | null;
  href: string;
  detail: string;
}
export const PersonDossierQuerySchema = z.object({
  query: z.string().max(500).default(""),
  categories: z.array(z.string().min(1).max(200)).max(10).default([]),
  constraints: z.array(z.string().min(1).max(200)).max(10).default([]),
  scale: z.object({ minimum: z.number().finite(), unit: z.string().min(1).max(200) }).optional(),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  visibility: z.enum(["public", "private"]).default("private"),
});
export type PersonDossierQuery = z.input<typeof PersonDossierQuerySchema>;
export interface PersonDossierMatch {
  profileId: string;
  name: string;
  dossierRevision: number;
  workIds: string[];
  claimIds: string[];
  citations: { sourceId: string; quote: string }[];
  gaps: string[];
}
export interface PersonDossierQueryResult {
  demonstrated: PersonDossierMatch[];
  claimed: PersonDossierMatch[];
  coverage: {
    activeProfiles: number;
    researchedProfiles: number;
    demonstrated: number;
    claimedOnly: number;
  };
  scope: string;
}
export interface PersonDossierAnalysis {
  activity: { period: string; kind: string; count: number }[];
  collaborations: {
    counterparty: string;
    distinctWorks: number;
    workIds: string[];
    claimIds: string[];
  }[];
  quality: {
    totalClaims: number;
    singleSourceClaims: number;
    unknownClaims: number;
    contestedClaims: number;
    composition: Record<string, number>;
    byClaim: { claimId: string; families: string[]; sourceClasses: string[] }[];
  };
  scope: string;
}
export interface PersonConnectionStep {
  fromProfileId: string;
  toProfileId: string;
  kind: string;
  direction: string;
  from: string | null;
  to: string | null;
  workIds: string[];
  claimIds: string[];
  citations: { sourceId: string; quote: string }[];
}
