import type { TranscriptRelevanceReviewState } from "@chief-of-staff-demo/shared";

/**
 * Transcript evidence for a Meeting Brief (issue #138).
 *
 * There are two approved retrieval lanes and they are not equal. A confirmed
 * person, organization, or meeting-series link makes a Transcript evidence the
 * Brief may compose and cite as fact. A similarity judgment makes it a
 * suggestion, and it stays one until the owner confirms it — the rule #127
 * established inside the Catalog, applied here at the Brief's seam so a
 * similarity score can never buy its way into a talking point.
 */

/** Why a Transcript is already evidence rather than a suggestion. */
type TranscriptEvidenceVia = "person" | "organization" | "meeting-series";

/** A Transcript reached through a confirmed link the Workspace already holds. */
interface ConfirmedTranscriptLink {
  transcriptId: string;
  via: TranscriptEvidenceVia;
  excerpt: string;
}

/** A Transcript reached by similarity, carrying the Catalog's review state. */
interface SemanticTranscriptCandidate {
  transcriptId: string;
  excerpt: string;
  score: number;
  reviewState: TranscriptRelevanceReviewState;
}

/** One cited excerpt composition may state as fact. */
interface TranscriptEvidenceItem {
  transcriptId: string;
  via: TranscriptEvidenceVia | "confirmed-relevance";
  excerpt: string;
}

/** One unconfirmed similarity result, shown for review and never composed. */
interface TranscriptEvidenceSuggestion {
  transcriptId: string;
  excerpt: string;
  score: number;
}

export interface TranscriptEvidenceSelection {
  evidence: TranscriptEvidenceItem[];
  suggestions: TranscriptEvidenceSuggestion[];
}

export interface TranscriptEvidenceInput {
  links: ConfirmedTranscriptLink[];
  semantic: SemanticTranscriptCandidate[];
}

/**
 * Split the two lanes into what may be cited and what may only be reviewed.
 * Only a semantic candidate the owner explicitly confirmed crosses over;
 * pending, rejected, and unresolved states never do, so an unreviewed
 * suggestion cannot block or enter a scheduled Brief.
 */
export function selectTranscriptEvidence(
  input: TranscriptEvidenceInput,
): TranscriptEvidenceSelection {
  const evidence: TranscriptEvidenceItem[] = input.links.map((link) => ({
    transcriptId: link.transcriptId,
    via: link.via,
    excerpt: link.excerpt,
  }));
  const suggestions: TranscriptEvidenceSuggestion[] = [];
  for (const candidate of input.semantic) {
    if (candidate.reviewState === "confirmed") {
      evidence.push({
        transcriptId: candidate.transcriptId,
        via: "confirmed-relevance",
        excerpt: candidate.excerpt,
      });
      continue;
    }
    if (candidate.reviewState === "pending") {
      suggestions.push({
        transcriptId: candidate.transcriptId,
        excerpt: candidate.excerpt,
        score: candidate.score,
      });
    }
  }
  return { evidence, suggestions };
}
