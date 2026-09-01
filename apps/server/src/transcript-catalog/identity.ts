import { createHash } from "node:crypto";
import type {
  IdentityDecision,
  RememberedMapping,
  TranscriptIdentityExtractionResult,
  TranscriptMatchCandidate,
  TranscriptRecord,
  TranscriptReviewQueue,
} from "@chief-of-staff-demo/shared";
import { TranscriptIdentityExtractionResultSchema } from "@chief-of-staff-demo/shared";
import type { WorkspacePersonProfiles } from "../person-profile/profiles.js";
import {
  extractMentions,
  IDENTITY_MINING_ALGORITHM_VERSION,
  normalizeName,
} from "./identity-extraction.js";
import {
  activeMappingFor,
  candidateSignals,
  conflictsFor,
  policyClassOf,
} from "./identity-matching.js";
import { type TranscriptIdentityMeta, TranscriptIdentityStore } from "./identity-store.js";

export interface TranscriptIdentityDeps {
  store: TranscriptIdentityStore;
  people: WorkspacePersonProfiles;
  extractor: TranscriptIdentityExtractor;
  now?: () => Date;
}

/** True-external model seam. Implementations may resolve asynchronously; the
 * service still validates the value against the strict shared Result Shape at
 * the trust boundary before using it. */
export interface TranscriptIdentityExtractor {
  extract(
    record: TranscriptRecord,
  ): TranscriptIdentityExtractionResult | Promise<TranscriptIdentityExtractionResult>;
}

class UnknownMentionError extends Error {
  constructor(mentionId: string) {
    super(`Unknown mention: ${mentionId}`);
    this.name = "UnknownMentionError";
  }
}

class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDecisionError";
  }
}

export interface DecideInput {
  mentionId: string;
  action: IdentityDecision["action"];
  profileId?: string;
  fullName?: string;
  primaryEmail?: string;
  scope?: RememberedMapping["scope"];
  note?: string;
}

/**
 * Identity mining over the Transcript Catalog (issue #126). Deterministic
 * recognition is supplemented by one validated strict extraction Result
 * Shape; the service persists mentions, Organization Mentions, and explainable
 * candidates. Only a non-conflicting exact stable identifier may auto-link to
 * an EXISTING Profile. Remembered mappings apply as explicit owner authority,
 * and no processing path creates a Person Profile; explicit review does.
 */
export class TranscriptIdentityService {
  private readonly store: TranscriptIdentityStore;
  private readonly people: WorkspacePersonProfiles;
  private readonly extractor: TranscriptIdentityExtractor;
  private readonly now: () => Date;

  constructor(deps: TranscriptIdentityDeps) {
    this.store = deps.store;
    this.people = deps.people;
    this.extractor = deps.extractor;
    this.now = deps.now ?? (() => new Date());
  }

  async backfill(records: TranscriptRecord[]): Promise<void> {
    for (const record of records) await this.process(record);
  }

  process(record: TranscriptRecord): void | Promise<void> {
    const inputVersion = identityInputVersion(record);
    if (this.store.wasProcessed(record.id, IDENTITY_MINING_ALGORITHM_VERSION, inputVersion)) {
      return;
    }
    const extracted = this.extractor.extract(record);
    if (extracted instanceof Promise) {
      return extracted.then((result) => this.finishProcess(record, inputVersion, result));
    }
    this.finishProcess(record, inputVersion, extracted);
  }

  private finishProcess(record: TranscriptRecord, inputVersion: string, rawResult: unknown): void {
    const supplement: TranscriptIdentityExtractionResult =
      TranscriptIdentityExtractionResultSchema.parse(rawResult);
    const { mentions, organizations } = extractMentions(record, supplement);
    const mappings = this.store.readMappings();
    const candidates: TranscriptMatchCandidate[] = [];
    const generatedAt = this.now().toISOString();

    for (const mention of mentions) {
      if (mention.kind !== "person" && mention.kind !== "ambiguous-name") continue;
      const mapping = activeMappingFor(mappings, record.id, mention.normalizedForms);
      const profiles = this.people.search({ includeArchived: true });
      const scored = profiles
        .map((profile) => {
          const signals = candidateSignals(mention, profile, mapping);
          const score = signals.filter((s) => s.matched).reduce((total, s) => total + s.weight, 0);
          return {
            profile,
            signals,
            score,
            conflicts: conflictsFor(mention, profile, profiles),
          };
        })
        .filter((entry) => entry.score > 0)
        .sort(
          (left, right) =>
            right.score - left.score || left.profile.id.localeCompare(right.profile.id),
        );

      scored.forEach((entry, index) => {
        const next = scored[index + 1];
        const leadOverNext = next === undefined ? null : entry.score - next.score;
        candidates.push({
          id: `tc_${createHash("sha1").update(`${mention.id}|${entry.profile.id}`).digest("hex").slice(0, 12)}`,
          mentionId: mention.id,
          transcriptId: record.id,
          profileId: entry.profile.id,
          policyClass: policyClassOf(
            mention,
            entry.signals,
            entry.conflicts,
            leadOverNext,
            index === 0,
          ),
          score: entry.score,
          leadOverNext,
          signals: entry.signals,
          conflicts: entry.conflicts,
          evidence: [
            {
              quote: mention.provenance.quote,
              spanStart: mention.provenance.spanStart,
              spanEnd: mention.provenance.spanEnd,
              timestamp: mention.provenance.timestamp,
              speakerLabel: mention.provenance.speakerLabel,
            },
          ],
          algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
          generatedAt,
        });
      });
    }

    this.store.saveTranscriptMeta(record.id, {
      fileName: record.source.fileName,
      meetingDate: record.meetingDate,
    } satisfies TranscriptIdentityMeta);
    this.store.replaceMentions(record.id, mentions);
    this.store.replaceOrganizations(record.id, organizations);
    this.store.replaceCandidates(record.id, candidates);

    /* Auto-link policy: only a non-conflicting exact stable identifier may
       produce a policy-made "confirmed" link — and only to an existing
       Profile. Nothing here creates one. */
    for (const mention of mentions) {
      if (this.store.latestDecision(mention.id) !== null) continue;
      const own = candidates
        .filter((candidate) => candidate.mentionId === mention.id)
        .sort((left, right) => right.score - left.score);
      const top = own[0];
      if (!top || top.policyClass !== "confirmed") continue;
      if (own.length > 1 && (top.leadOverNext === null || top.leadOverNext <= 0)) continue;
      this.store.appendDecision({
        id: `id_${createHash("sha1").update(`${mention.id}|auto`).digest("hex").slice(0, 12)}`,
        mentionId: mention.id,
        transcriptId: record.id,
        action: "confirm",
        outcome: "linked",
        profileId: top.profileId,
        profileRevision: this.people.get(top.profileId)?.revision ?? null,
        decidedBy: "policy",
        decidedAt: generatedAt,
        note: "Auto-linked on a non-conflicting exact stable identifier.",
      });
    }

    /* A remembered mapping is standing owner authority, not stable identity
       evidence. Applying it records an owner decision and never upgrades the
       candidate's policy class to confirmed. */
    for (const mention of mentions) {
      if (this.store.latestDecision(mention.id) !== null) continue;
      const mapping = activeMappingFor(mappings, record.id, mention.normalizedForms);
      if (mapping === null || this.people.get(mapping.profileId) === null) continue;
      this.store.appendDecision({
        id: `id_${createHash("sha1").update(`${mention.id}|mapping|${mapping.id}|${mapping.mappingVersion}`).digest("hex").slice(0, 12)}`,
        mentionId: mention.id,
        transcriptId: record.id,
        action: "remember-mapping",
        outcome: "linked",
        profileId: mapping.profileId,
        profileRevision: this.people.get(mapping.profileId)?.revision ?? null,
        decidedBy: "owner",
        decidedAt: generatedAt,
        note: `Applied remembered mapping ${mapping.id} v${mapping.mappingVersion} (${mapping.scope} scope).`,
      });
    }
    this.store.markProcessed({
      transcriptId: record.id,
      algorithmVersion: IDENTITY_MINING_ALGORITHM_VERSION,
      inputVersion,
      processedAt: generatedAt,
    });
  }

  /** The shared Person Profiles Review queue: everything weaker than an
   *  auto-link stays here, reviewable, with its full explanation. */
  reviewQueue(): TranscriptReviewQueue {
    const meta = this.store.readTranscriptMeta();
    const mentions = this.store.readMentions();
    const candidates = this.store.readCandidates();
    const organizations = this.store.readOrganizations();
    const mappings = this.store.readMappings();
    return {
      items: mentions
        .filter((mention) => mention.kind === "person" || mention.kind === "ambiguous-name")
        .map((mention) => ({
          transcriptId: mention.provenance.transcriptId,
          transcriptFileName: meta[mention.provenance.transcriptId]?.fileName ?? null,
          meetingDate: meta[mention.provenance.transcriptId]?.meetingDate ?? null,
          mention,
          // Highest-scoring explanation first; presentation order only.
          candidates: candidates
            .filter((candidate) => candidate.mentionId === mention.id)
            .sort(
              (left, right) =>
                right.score - left.score ||
                (right.leadOverNext ?? Number.NEGATIVE_INFINITY) -
                  (left.leadOverNext ?? Number.NEGATIVE_INFINITY) ||
                left.profileId.localeCompare(right.profileId),
            ),
          decision: this.store.latestDecision(mention.id),
          rememberedMapping: activeMappingFor(
            mappings,
            mention.provenance.transcriptId,
            mention.normalizedForms,
          ),
        })),
      organizations: organizations.map((organization) => ({
        transcriptId: organization.provenance.transcriptId,
        transcriptFileName: meta[organization.provenance.transcriptId]?.fileName ?? null,
        organization,
        relatedPeople: mentions
          .filter((mention) => organization.relatedMentionIds.includes(mention.id))
          .map((mention) => ({ mentionId: mention.id, surfaceText: mention.surfaceText })),
      })),
    };
  }

  /**
   * One owner decision from the Review queue. Explicit only: this is the
   * single path through which review work becomes identity, including the
   * one that creates a Profile (the owner's explicit act, never mining's).
   * A decision fans out to the mention named and to undecided mentions of
   * the same form in the same transcript, each recorded as its own audit
   * entry.
   */
  decide(input: DecideInput): IdentityDecision {
    const mention = this.store.readMentions().find((m) => m.id === input.mentionId);
    if (!mention) throw new UnknownMentionError(input.mentionId);
    const transcriptId = mention.provenance.transcriptId;
    const decidedAt = this.now().toISOString();

    let outcome: IdentityDecision["outcome"];
    let profileId: string | null = null;
    switch (input.action) {
      case "confirm": {
        const candidate = input.profileId
          ? this.store
              .readCandidates()
              .find((c) => c.mentionId === mention.id && c.profileId === input.profileId)
          : this.topCandidate(mention.id);
        if (!candidate) {
          throw new InvalidDecisionError("Confirm requires an existing Profile candidate.");
        }
        profileId = candidate.profileId;
        outcome = "linked";
        break;
      }
      case "alternate-profile":
      case "remember-mapping": {
        if (!input.profileId) {
          throw new InvalidDecisionError(`${input.action} requires a Profile id.`);
        }
        if (!this.people.get(input.profileId)) {
          throw new InvalidDecisionError(`Unknown Profile: ${input.profileId}`);
        }
        profileId = input.profileId;
        outcome = "linked";
        break;
      }
      case "create-profile": {
        const observedEmail = mention.emails[0];
        const fullName =
          input.fullName ?? (observedEmail === undefined ? mention.surfaceText : undefined);
        const primaryEmail = input.primaryEmail ?? observedEmail;
        const created = this.people.create({
          ...(fullName === undefined ? {} : { fullName }),
          ...(primaryEmail === undefined ? {} : { primaryEmail }),
        });
        profileId = created.id;
        outcome = "created";
        break;
      }
      case "not-a-person":
        outcome = "not-a-person";
        break;
      case "unresolved":
        outcome = "unresolved";
        break;
    }
    const profileRevision =
      profileId === null ? null : (this.people.get(profileId)?.revision ?? null);

    const targets =
      input.action === "remember-mapping"
        ? this.store
            .readMentions()
            .filter(
              (other) =>
                other.provenance.transcriptId === transcriptId &&
                other.normalizedForms.some((form) => mention.normalizedForms.includes(form)),
            )
        : [mention];
    for (const target of targets) {
      const isNamedTarget = target.id === mention.id;
      /* The named mention is re-decided (its latest decision supersedes);
         same-form mentions only pick up the decision while undecided. */
      if (!isNamedTarget && this.store.latestDecision(target.id) !== null) continue;
      this.store.appendDecision({
        id: `id_${createHash("sha1")
          .update(`${target.id}|${input.action}|${decidedAt}|${profileId ?? ""}`)
          .digest("hex")
          .slice(0, 12)}`,
        mentionId: target.id,
        transcriptId,
        action: input.action,
        outcome,
        profileId,
        profileRevision,
        decidedBy: "owner",
        decidedAt,
        note: input.note ?? null,
      });
    }

    if (input.action === "remember-mapping" && profileId !== null) {
      const scope = input.scope ?? "transcript";
      const scopeId = scope === "transcript" ? transcriptId : null;
      const normalizedForm = mention.normalizedForms[0] ?? normalizeName(mention.surfaceText);
      const mappingId = `rm_${createHash("sha1")
        .update(`${scope}|${scopeId ?? ""}|${normalizedForm}`)
        .digest("hex")
        .slice(0, 12)}`;
      const existing = this.store.readMappings().find((m) => m.id === mappingId);
      this.store.saveMapping({
        id: mappingId,
        scope,
        scopeId,
        normalizedForm,
        surfaceText: mention.surfaceText,
        profileId,
        mappingVersion: (existing?.mappingVersion ?? 0) + 1,
        createdAt: existing?.createdAt ?? decidedAt,
        revokedAt: null,
      });
    }

    const decided = this.store.readDecisions().filter((d) => d.mentionId === mention.id);
    const latest = decided.at(-1);
    if (!latest) throw new InvalidDecisionError("Decision was not persisted.");
    return latest;
  }

  mappings(): RememberedMapping[] {
    return this.store.readMappings();
  }

  /** Reversible by design: revocation prevents future application and appends
   * unresolved decisions that invalidate every currently mapping-derived
   * link inside this mapping's declared scope. */
  revokeMapping(mappingId: string): RememberedMapping {
    const mapping = this.store.readMappings().find((m) => m.id === mappingId);
    if (!mapping) throw new InvalidDecisionError(`Unknown remembered mapping: ${mappingId}`);
    const revokedAt = this.now().toISOString();
    const revoked: RememberedMapping = { ...mapping, revokedAt };
    this.store.saveMapping(revoked);
    for (const mention of this.store.readMentions()) {
      const inScope =
        mapping.scope === "workspace" || mapping.scopeId === mention.provenance.transcriptId;
      if (!inScope || !mention.normalizedForms.includes(mapping.normalizedForm)) continue;
      const latest = this.store.latestDecision(mention.id);
      if (
        latest?.action !== "remember-mapping" ||
        latest.outcome !== "linked" ||
        latest.profileId !== mapping.profileId
      ) {
        continue;
      }
      this.store.appendDecision({
        id: `id_${createHash("sha1").update(`${mention.id}|revoke|${mapping.id}|${revokedAt}`).digest("hex").slice(0, 12)}`,
        mentionId: mention.id,
        transcriptId: mention.provenance.transcriptId,
        action: "unresolved",
        outcome: "unresolved",
        profileId: null,
        profileRevision: null,
        decidedBy: "owner",
        decidedAt: revokedAt,
        note: `Invalidated link from revoked remembered mapping ${mapping.id} v${mapping.mappingVersion}.`,
      });
    }
    return revoked;
  }

  private topCandidate(mentionId: string): TranscriptMatchCandidate | null {
    const own = this.store
      .readCandidates()
      .filter((candidate) => candidate.mentionId === mentionId)
      .sort((left, right) => right.score - left.score);
    return own.find((candidate) => !candidate.conflicts.some((conflict) => conflict.hard)) ?? null;
  }
}

/** Derived-input version for the durable processing ledger. Calendar/provider
 * speaker identity enrichment can change while the transcript artifact stays
 * immutable, and must trigger a fresh identity pass. */
function identityInputVersion(record: TranscriptRecord): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        checksum: record.source.checksum,
        speakerIdentityMappings: record.speakerIdentityMappings,
      }),
    )
    .digest("hex");
}
