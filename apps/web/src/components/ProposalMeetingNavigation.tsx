import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import type { ActionItemIndex } from "@chief-of-staff-demo/shared";
import { tasksApi, type TasksClient } from "../clients/tasks";
import { errorMessage } from "../client";

/** Complete source navigation over canonical pending state; never an acceptance queue. */
export function ProposalMeetingNavigation({
  client = tasksApi,
  meetingId = "",
  missingSource = false,
}: {
  client?: TasksClient;
  meetingId?: string;
  missingSource?: boolean;
}) {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedId = hash.startsWith("#action-item-") ? hash.slice("#action-item-".length) : null;
  const sourceUrl = searchParams.get("source");
  const sourceAvailability =
    sourceUrl === "available" || sourceUrl === "unavailable"
      ? sourceUrl
      : missingSource
        ? "unavailable"
        : "all";
  const sourceRunId = searchParams.get("debriefRunId") ?? "";
  const [index, setIndex] = useState<ActionItemIndex | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let generation = 0;
    const load = async () => {
      const current = ++generation;
      try {
        const result = await client.actionItems({
          ...(requestedId ? {} : { state: "pending" as const }),
          ...(meetingId ? { meetingId } : {}),
          ...(sourceAvailability !== "all" ? { source: sourceAvailability } : {}),
          ...(sourceRunId ? { debriefRunId: sourceRunId } : {}),
        });
        if (live && current === generation) {
          const item = requestedId ? result.items.find((item) => item.id === requestedId) : null;
          if (item) {
            const meeting = result.context?.[item.id]?.meeting;
            const source = meeting
              ? `/meetings/${encodeURIComponent(meeting.id)}?tab=debrief`
              : `/meetings/recovery/${encodeURIComponent(item.source.debriefRunId)}?retained=1`;
            void navigate(`${source}#action-item-${encodeURIComponent(item.id)}`, {
              replace: true,
            });
          }
          setIndex({ ...result, items: result.items.filter((item) => item.state === "pending") });
          setError(null);
        }
      } catch (cause) {
        if (live && current === generation) setError(errorMessage(cause));
      }
    };
    void load();
    const onFocus = () => {
      void load();
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => void load(), 3000);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [client, meetingId, missingSource, requestedId, sourceAvailability, sourceRunId, navigate]);
  if (error) return <p role="alert">Approval navigation unavailable: {error}</p>;
  if (!index) return <p role="status">Loading approvals…</p>;
  const groups = new Map<string, { title: string; count: number; available: boolean }>();
  for (const item of index.items) {
    const meeting = index.context?.[item.id]?.meeting;
    const to = meeting
      ? `/meetings/${encodeURIComponent(meeting.id)}?tab=debrief#action-items`
      : `/meetings/recovery/${encodeURIComponent(item.source.debriefRunId)}?retained=1`;
    const previous = groups.get(to);
    groups.set(to, {
      title: meeting?.title ?? "Source Meeting unavailable",
      available: !!meeting,
      count: (previous?.count ?? 0) + 1,
    });
  }
  const setAvailability = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "all") next.delete("source");
    else next.set("source", value);
    setSearchParams(next, { replace: false });
  };
  const setSourceRun = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value) next.set("debriefRunId", value);
    else next.delete("debriefRunId");
    setSearchParams(next, { replace: false });
  };
  const runIds = [...new Set(index.items.map((item) => item.source.debriefRunId))].sort();
  return (
    <>
      <p>Awaiting approval ({index.items.length})</p>
      <form className="card" onSubmit={(event) => event.preventDefault()}>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="action-item-source-availability">Source availability</label>
            <select
              id="action-item-source-availability"
              value={sourceAvailability}
              onChange={(event) => setAvailability(event.target.value)}
            >
              <option value="all">All sources</option>
              <option value="available">Source available</option>
              <option value="unavailable">Source Meeting unavailable</option>
            </select>
          </div>
          {runIds.length > 1 && (
            <div className="field">
              <label htmlFor="action-item-source-run">Source run</label>
              <select
                id="action-item-source-run"
                value={sourceRunId}
                onChange={(event) => setSourceRun(event.target.value)}
              >
                <option value="">All source runs</option>
                {runIds.map((id) => (
                  <option key={id} value={id}>
                    {id}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </form>
      {meetingId && groups.size === 0 && (
        <Link to={`/meetings/${encodeURIComponent(meetingId)}?tab=debrief#action-items`}>
          Review on source Meeting
        </Link>
      )}
      <ul className="card-list">
        {[...groups].map(([to, group]) => (
          <li key={to}>
            <p>
              {group.title} · {group.count} pending
            </p>
            <Link to={to}>
              {group.available ? "Review on source Meeting" : "Recover retained proposals"}
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
