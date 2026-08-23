import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { DriveIntakeStatus } from "@chief-of-staff-demo/shared";
import { RunsList } from "../components/RunsList";
import { relativeTime } from "../display";
import { api } from "../client";
import { useGoogleConnection } from "../useGoogleConnection";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * The transcript Module's page: its own chrome — the Drive folder's liveness
 * line and where to change it — plus the Shell's Runs list filtered to this
 * Module. What the two pages share is the list component, not the page, so
 * another Module's Run can never appear under this one.
 */
export function RunsPage() {
  useTitle("Runs");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  const [intake, setIntake] = useState<DriveIntakeStatus | null>(null);
  /* The connection is the Shell's, and its banner renders above this page
     (ADR-0011). The liveness line below is hidden unless it is connected. */
  const { status: googleStatus } = useGoogleConnection();

  /* Rides along with every list refresh: mount, manual Refresh, and the
     active-run interval. Its own failure must not blank the list, so it
     degrades to the last known (or no) status. */
  const loadIntake = useCallback(() => {
    void api
      .driveIntakeStatus()
      .then((next) => setIntake(next))
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    loadIntake();
  }, [loadIntake]);

  return (
    <div className="page">
      <div className="page-header">
        <h1 ref={headingRef} tabIndex={-1}>
          Runs
        </h1>
      </div>

      {/* Ticket 12: the liveness line. Remembered facts only — the endpoint
          makes zero Google calls, and after a restart, before the first poll,
          it claims no last-checked time it does not have. Hidden entirely when
          the connection or folder is missing: silence, not a stale promise. */}
      {googleStatus?.state === "connected" && intake?.configured && intake.enabled && (
        <p className="muted" data-testid="intake-liveness">
          Watching {intake.folderName || "your Drive folder"}
          {intake.lastPollAt
            ? ` · last checked ${relativeTime(intake.lastPollAt)}` +
              (intake.lastPollOutcome === "failed" ? " (that check failed)" : "")
            : ""}
          {" · "}
          every {intake.pollIntervalMinutes} min
        </p>
      )}

      <p className="muted">
        Transcripts are read from your Google Drive folder. Choose it in <Link to="/settings">Settings → Drive transcripts</Link> and click <strong>Sync now</strong> if you don&apos;t want to wait for the next poll.
      </p>

      <RunsList
        module="transcript"
        onRefresh={loadIntake}
        empty={
          <>
            <p className="muted">No runs yet. Add a transcript to your Drive folder and it will appear here.</p>
            <p className="muted">Supported: .txt, .md, .json, .jsonc, .pdf, .docx, and native Google Docs.</p>
          </>
        }
      />

      <p className="muted">
        <Link to="/runs">Every Module&apos;s runs</Link>
      </p>
    </div>
  );
}
