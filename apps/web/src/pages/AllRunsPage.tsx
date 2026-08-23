import { Link } from "react-router-dom";
import { RunsList } from "../components/RunsList";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/**
 * Every Module's Runs, in one place. A Shell page rather than a tab: the tab bar
 * renders live Modules and ADR-0014 made a tab a promise about function, so a
 * Runs tab would be the bar's first entry that is not a Module. ADR-0010 refused
 * Home a Runs list and ADR-0014 gave it a capped feed instead; a route the feed
 * links into respects both rather than revising the same boundary a third time.
 *
 * No filter controls: the Module column says whose Run each row is, each
 * Module's page is the Module filter, and a newest-first paged list in a
 * single-user app has nothing a status dropdown would rescue.
 */
export function AllRunsPage() {
  useTitle("All runs");
  const headingRef = usePageFocus<HTMLHeadingElement>();

  return (
    <div className="page">
      <div className="page-header">
        <h1 ref={headingRef} tabIndex={-1}>
          All runs
        </h1>
      </div>
      <p className="muted">
        Every Module's runs, newest first. A Module's own tab shows only its own.
      </p>
      <RunsList
        empty={
          <p className="muted">
            No runs yet. A Module starts one when its Intake finds work — see{" "}
            <Link to="/">Home</Link> for what is live.
          </p>
        }
      />
    </div>
  );
}
