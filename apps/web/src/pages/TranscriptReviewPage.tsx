import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type {
  TranscriptRelevanceReviewItem,
  TranscriptRelevanceReviewState,
} from "@chief-of-staff-demo/shared";
import { api, errorMessage } from "../client";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * The semantic transcript relevance Review surface (spec #117, issue #127):
 * full-corpus discovery is a suggestion lane. Every result arrives as a
 * cited, explained excerpt with its review state, and only an explicit owner
 * decision moves it — confirming relevance never changes a Profile.
 */
const STATE_FILTERS = ["all", "pending", "confirmed", "rejected", "unresolved"] as const;

const REVIEW_STATE_LABEL: Record<TranscriptRelevanceReviewState, string> = {
  pending: "Pending review",
  confirmed: "Confirmed",
  rejected: "Rejected",
  unresolved: "Left unresolved",
};

export function TranscriptReviewPage() {
  useTitle("Transcript review");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const [items, setItems] = useState<TranscriptRelevanceReviewItem[] | null>(null);
  const [query, setQuery] = useState("");
  const [meetingTitle, setMeetingTitle] = useState("");
  const [topics, setTopics] = useState("");
  const [stateFilter, setStateFilter] = useState<(typeof STATE_FILTERS)[number]>("all");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const queue = await api.transcriptRelevanceQueue();
      setItems(queue.items);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runSearch = async () => {
    setError(null);
    setNotice(null);
    setSearching(true);
    try {
      const topicList = topics
        .split(",")
        .map((topic) => topic.trim())
        .filter((topic) => topic.length > 0);
      const result = await api.searchTranscriptRelevance({
        text: query,
        ...(meetingTitle.trim() || topicList.length > 0
          ? {
              meeting: {
                ...(meetingTitle.trim() ? { title: meetingTitle.trim() } : {}),
                ...(topicList.length > 0 ? { topics: topicList } : {}),
              },
            }
          : {}),
      });
      setItems(result.items);
      setNotice(
        result.items.some((item) => item.reviewState === "pending")
          ? "Search finished. Nothing here is a fact: confirm, reject, or leave each result unresolved."
          : "Search finished. No new relevance candidates.",
      );
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSearching(false);
    }
  };

  const decide = async (candidateId: string, action: "confirm" | "reject" | "unresolved") => {
    setError(null);
    setNotice(null);
    try {
      const { item } = await api.decideTranscriptRelevance(candidateId, action);
      setItems((current) =>
        (current ?? []).map((entry) => (entry.candidate.id === candidateId ? item : entry)),
      );
      setNotice(
        action === "confirm"
          ? "Relevance confirmed. It is now an auditable relevance decision — it still does not change any Profile."
          : action === "reject"
            ? "Relevance rejected. The result stays out of every factual consumer."
            : "Left unresolved. The result stays reviewable and non-factual.",
      );
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  const visible = (items ?? []).filter(
    (item) => stateFilter === "all" || item.reviewState === stateFilter,
  );

  return (
    <>
      <h1 ref={focusRef} tabIndex={-1}>
        Transcript review
      </h1>
      <p className="muted">
        Search the whole retained transcript corpus for conversations relevant to a meeting or a
        topic. Results are suggestions with citations: nothing becomes fact — not a Profile fact,
        not Brief evidence, not an attendee identity — until you confirm it here.
      </p>
      {error && (
        <p className="banner-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="banner-ok" role="status">
          {notice}
        </p>
      )}
      <form
        className="form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          void runSearch();
        }}
      >
        <div className="field-row">
          <label htmlFor="relevance-query">Search the transcript corpus</label>
          <input
            id="relevance-query"
            type="search"
            value={query}
            placeholder="e.g. export button timing out on large accounts"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="field-row">
          <label htmlFor="relevance-meeting-title">Meeting title (optional)</label>
          <input
            id="relevance-meeting-title"
            type="text"
            value={meetingTitle}
            onChange={(event) => setMeetingTitle(event.target.value)}
          />
        </div>
        <div className="field-row">
          <label htmlFor="relevance-topics">Topics (optional, comma-separated)</label>
          <input
            id="relevance-topics"
            type="text"
            value={topics}
            onChange={(event) => setTopics(event.target.value)}
          />
        </div>
        <div className="field-row runs-toolbar">
          <button className="action-button primary" type="submit" disabled={searching}>
            {searching ? "Searching…" : "Search transcripts"}
          </button>
          <label htmlFor="relevance-state-filter">Review state</label>
          <select
            id="relevance-state-filter"
            value={stateFilter}
            onChange={(event) =>
              setStateFilter(event.target.value as (typeof STATE_FILTERS)[number])
            }
          >
            {STATE_FILTERS.map((state) => (
              <option key={state} value={state}>
                {state === "all" ? "All states" : REVIEW_STATE_LABEL[state]}
              </option>
            ))}
          </select>
          <Link className="linklike" to="/people">
            Back to Person Profiles
          </Link>
        </div>
      </form>
      {items === null ? (
        <p className="muted">Loading…</p>
      ) : visible.length === 0 ? (
        <p className="muted">
          {items.length === 0
            ? "No relevance candidates yet. Search the corpus to find reviewable excerpts."
            : "No results in that review state."}
        </p>
      ) : (
        <ul className="relevance-list">
          {visible.map((item) => (
            <li key={item.candidate.id} className="card">
              <h2>{item.candidate.sourceContext.fileName}</h2>
              <blockquote>{item.candidate.excerpt.text}</blockquote>
              <dl>
                <dt>Meeting date</dt>
                <dd>{item.candidate.sourceContext.meetingDate ?? "—"}</dd>
                <dt>Relevance explanation</dt>
                <dd>{item.candidate.explanation}</dd>
                <dt>Index or model version</dt>
                <dd>{item.candidate.relevanceVersion}</dd>
                <dt>Review state</dt>
                <dd>{REVIEW_STATE_LABEL[item.reviewState]}</dd>
                {item.decision?.note && (
                  <>
                    <dt>Decision note</dt>
                    <dd>{item.decision.note}</dd>
                  </>
                )}
              </dl>
              {item.candidate.sourceContext.sourceUrl && (
                <p>
                  <a href={item.candidate.sourceContext.sourceUrl}>Open source document</a>
                </p>
              )}
              {item.reviewState === "pending" && (
                <div className="field-row runs-toolbar">
                  <button
                    className="action-button primary"
                    type="button"
                    onClick={() => void decide(item.candidate.id, "confirm")}
                  >
                    Confirm relevance
                  </button>
                  <button
                    className="action-button"
                    type="button"
                    onClick={() => void decide(item.candidate.id, "reject")}
                  >
                    Reject
                  </button>
                  <button
                    className="linklike"
                    type="button"
                    onClick={() => void decide(item.candidate.id, "unresolved")}
                  >
                    Leave unresolved
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
