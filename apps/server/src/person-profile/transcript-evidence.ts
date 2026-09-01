import type { PersonEvidence, PersonProfile, TranscriptRecord } from "@chief-of-staff-demo/shared";
import type { TranscriptConsumerRegistry } from "../transcript-catalog/deletion.js";
import type { PersonProfileStore } from "./store.js";

/**
 * The evidence convention for transcript-origin Person Evidence: the
 * evidence's `source` names the Transcript Catalog, and its `url` carries
 * the transcript id it was observed in. Evidence that satisfies it is
 * transcript-derived and goes with the transcript; every other evidence
 * record — Calendar shells, HubSpot contacts, public-web research — is
 * independently supported and survives the cascade untouched.
 */
const TRANSCRIPT_EVIDENCE_SOURCE = "transcript-catalog";

function isTranscriptOrigin(evidence: PersonEvidence, transcriptId: string): boolean {
  return evidence.source === TRANSCRIPT_EVIDENCE_SOURCE && evidence.url === transcriptId;
}

function withoutTranscriptOrigin(
  profile: PersonProfile,
  transcriptId: string,
): { profile: PersonProfile; removed: number } | null {
  const kept = profile.evidence.filter((evidence) => !isTranscriptOrigin(evidence, transcriptId));
  if (kept.length === profile.evidence.length) return null;
  return {
    profile: { ...profile, evidence: kept },
    removed: profile.evidence.length - kept.length,
  };
}

/**
 * The Person Profiles consumer registration for transcript deletion (issue
 * #128, mirroring the #122 lifecycle registry). It purges transcript-origin
 * Person Evidence from the current records and from the persisted revision
 * copies, so no transcript text survives on any Profile after deletion.
 * Profile identity — names, emails, handles — is owner-entered or sourced
 * elsewhere and survives, exactly as the spec's independently supported
 * facts do.
 */
export class WorkspacePersonProfileTranscriptEvidence implements TranscriptConsumerRegistry {
  readonly consumer = "person-profiles";
  readonly label = "Transcript-origin Person Evidence held on Person Profiles";

  constructor(private readonly store: PersonProfileStore) {}

  inspect(record: TranscriptRecord): number {
    return this.store
      .list()
      .reduce(
        (total, profile) =>
          total + profile.evidence.filter((e) => isTranscriptOrigin(e, record.id)).length,
        0,
      );
  }

  purge(transcriptId: string): number {
    let removed = 0;
    for (const profile of this.store.list()) {
      const current = withoutTranscriptOrigin(profile, transcriptId);
      if (current) {
        this.store.saveCurrent(current.profile);
        removed += current.removed;
      }
      /* Sensitive copies in revisions go too: a revision that still holds
         the evidence would keep the deleted transcript's text alive. The
         count stays with the current records; the revision scrub is hygiene. */
      for (const revision of this.store.listRevisions(profile.id)) {
        const scrubbed = withoutTranscriptOrigin(revision, transcriptId);
        if (scrubbed) this.store.replaceRevision(scrubbed.profile);
      }
    }
    return removed;
  }
}
