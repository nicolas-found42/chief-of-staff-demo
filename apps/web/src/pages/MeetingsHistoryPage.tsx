import { useReadingPosition } from "../useReadingPosition";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { MeetingHistoryView } from "@chief-of-staff-demo/shared";
import { meetingsApi } from "../clients/meetings";
import { MeetingWizardTabs } from "../components/MeetingWizardTabs";
import { MeetingReadRow } from "../components/MeetingReadRow";
import { meetingDate } from "../meetingDisplay";
import { useTitle } from "../useTitle";
import { usePageFocus } from "../usePageFocus";
import "./meetingWizard.css";

export function MeetingsHistoryPage() {
  useTitle("Meeting history");
  const heading = usePageFocus<HTMLHeadingElement>({ focusOnSearchChange: false });
  const [params, setParams] = useSearchParams();
  const query = params.toString();
  /* BrowserRouter commits navigation in a transition (#325). Keep edits together
     until that commit, or typing immediately after Clear can revive old dates. */
  const pendingParams = useRef(params);
  useEffect(() => {
    pendingParams.current = params;
  }, [params]);
  /* A controlled checkbox must acknowledge its click synchronously; deriving
     it only from the transitioning URL briefly restores its old checked state. */
  const [includeCancelled, setIncludeCancelled] = useState(
    params.get("includeCancelled") === "true",
  );
  useEffect(
    () => setIncludeCancelled(new URLSearchParams(query).get("includeCancelled") === "true"),
    [query],
  );
  const [view, setView] = useState<MeetingHistoryView | null>(null);
  useReadingPosition(view !== null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const load = useCallback(async () => {
    const request = ++generation.current;
    try {
      const result = await meetingsApi.history(query);
      if (request === generation.current) {
        setView(result);
        setError(null);
      }
    } catch {
      if (request === generation.current)
        setError(
          "History could not be loaded. Check that the dates are valid and From is on or before To, then refresh.",
        );
    }
  }, [query]);
  useEffect(() => {
    setView(null);
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    const invalidate = () => {
      generation.current++;
    };
    return () => {
      invalidate();
      window.clearInterval(timer);
    };
  }, [load]);
  function filter(key: string, value: string) {
    const next = new URLSearchParams(pendingParams.current);
    if (value) next.set(key, value);
    else next.delete(key);
    next.delete("page");
    pendingParams.current = next;
    setParams(next);
  }
  function page(number: number) {
    const next = new URLSearchParams(pendingParams.current);
    next.set("page", String(number));
    pendingParams.current = next;
    setParams(next);
  }
  return (
    <div className="page">
      <header className="wizard-head">
        <h1 ref={heading} tabIndex={-1}>
          Meeting history
        </h1>
        <MeetingWizardTabs />
        <p>Retained past Meetings, their Briefs, and their Debriefs.</p>
        <button type="button" onClick={() => void load()}>
          Refresh
        </button>
      </header>
      <form className="history-filters" onSubmit={(event) => event.preventDefault()}>
        <label>
          Search meetings
          <input
            type="search"
            value={params.get("search") ?? ""}
            onChange={(event) => filter("search", event.target.value)}
          />
        </label>
        <label>
          From
          <input
            type="date"
            value={params.get("from") ?? ""}
            onChange={(event) => filter("from", event.target.value)}
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={params.get("to") ?? ""}
            onChange={(event) => filter("to", event.target.value)}
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={includeCancelled}
            onChange={(event) => {
              const checked = event.target.checked;
              setIncludeCancelled(checked);
              filter("includeCancelled", checked ? "true" : "");
            }}
          />
          Include cancelled
        </label>
        <Link
          to="/meetings/history"
          onClick={() => {
            pendingParams.current = new URLSearchParams();
            setIncludeCancelled(false);
          }}
        >
          Clear filters
        </Link>
      </form>
      {error ? <p role="alert">{error}</p> : null}
      {view ? (
        <>
          {view.partial.map((message) => (
            <p role="status" key={message}>
              {message}
            </p>
          ))}
          {view.historyBeginsAt ? (
            <p>
              Recorded history begins {meetingDate(view.historyBeginsAt)}. This is the earliest
              retained Meeting, not a complete Google Calendar history.
            </p>
          ) : null}
          <p role="status">
            {view.total} meetings · Page {view.page} of{" "}
            {Math.max(1, Math.ceil(view.total / view.pageSize))}
          </p>
          {view.meetings.length ? (
            <ul className="wizard-ledger">
              {view.meetings.map((meeting) => (
                <MeetingReadRow
                  key={meeting.id}
                  meeting={meeting}
                  timezone={view.timezone}
                  refresh={() => void load()}
                  excerpt
                />
              ))}
            </ul>
          ) : (
            <p>
              {view.retainedTotal === 0
                ? "No recorded meeting history yet."
                : "No meetings match these filters."}
            </p>
          )}
          <nav aria-label="History pages">
            <button type="button" disabled={view.page <= 1} onClick={() => page(view.page - 1)}>
              Previous page
            </button>{" "}
            <button
              type="button"
              disabled={view.page * view.pageSize >= view.total}
              onClick={() => page(view.page + 1)}
            >
              Next page
            </button>
          </nav>
        </>
      ) : !error ? (
        <p role="status">Loading history…</p>
      ) : null}
    </div>
  );
}
