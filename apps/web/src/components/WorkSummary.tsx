import { Link } from "react-router-dom";
import {
  TASK_COMPACT_LIMIT,
  type TaskOverview,
  type TaskOverviewCounts,
} from "@chief-of-staff-demo/shared";

/**
 * The compact view of canonical work (issue #192): the counts, then the two
 * lists that stay two lists. A Task is accepted work and an Action Item is a
 * proposal awaiting a decision, so they are never merged into one queue —
 * every row links to the Tasks product, which owns the record it names.
 *
 * Capped at eight rows per list, with the total beside the heading and a View
 * all link, so a compact surface is short without hiding how much there is.
 */

/** The metric strip, in the order the day is read. */
const METRICS: Array<{ key: keyof TaskOverviewCounts; label: string; to: string }> = [
  { key: "open", label: "Open", to: "/tasks" },
  { key: "overdue", label: "Overdue", to: "/tasks" },
  { key: "dueToday", label: "Due today", to: "/tasks" },
  { key: "pendingActionItems", label: "Pending review", to: "/tasks#action-items" },
  { key: "failedLinks", label: "Failed links", to: "/tasks" },
  { key: "conflictedLinks", label: "Needs a decision", to: "/tasks" },
];

function WorkMetrics({ counts }: { counts: TaskOverviewCounts }) {
  return (
    <ul className="work-metrics">
      {METRICS.map((metric) => (
        <li key={metric.key} className="work-metric">
          <Link to={metric.to}>
            <span className="work-metric-value">{counts[metric.key]}</span>
            <span className="work-metric-label">{metric.label}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** One compact group: a heading carrying its own total, and up to eight rows. */
function CompactGroup({
  heading,
  total,
  viewAll,
  empty,
  children,
}: {
  heading: string;
  total: number;
  viewAll: string;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="work-group">
      <h3>
        {heading} <span className="muted">({total})</span>
      </h3>
      {total === 0 ? (
        <p className="muted">{empty}</p>
      ) : (
        <>
          <ul className="home-feed">{children}</ul>
          {total > TASK_COMPACT_LIMIT && (
            <p>
              <Link to={viewAll}>View all {total}</Link>
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function WorkSummary({ overview }: { overview: TaskOverview }) {
  return (
    <div className="work-summary">
      <WorkMetrics counts={overview.counts} />
      <CompactGroup
        heading="Tasks"
        total={overview.counts.open}
        viewAll="/tasks"
        empty="No open Tasks."
      >
        {overview.tasks.map((task) => (
          <li key={task.id}>
            <Link to={`/tasks#task-${task.id}`} className="home-feed-title">
              {task.title}
            </Link>
            <span className="muted home-feed-meta">
              {task.dueDate ? (
                <>
                  {task.dueDate < overview.today ? "Overdue " : "Due "}
                  <time dateTime={task.dueDate}>{task.dueDate}</time>
                </>
              ) : (
                "No due date"
              )}
              {task.priority !== "none" ? ` · ${task.priority} priority` : ""}
            </span>
          </li>
        ))}
      </CompactGroup>
      <CompactGroup
        heading="Action Items awaiting review"
        total={overview.counts.pendingActionItems}
        viewAll="/tasks#action-items"
        empty="Nothing is waiting on a decision."
      >
        {overview.actionItems.map((item) => (
          <li key={item.id}>
            <Link to={`/tasks#action-item-${item.id}`} className="home-feed-title">
              {item.proposal.title}
            </Link>
            <span className="muted home-feed-meta">
              {item.proposal.dueDate ? (
                <>
                  Proposed due <time dateTime={item.proposal.dueDate}>{item.proposal.dueDate}</time>
                </>
              ) : (
                "No proposed due date"
              )}
            </span>
          </li>
        ))}
      </CompactGroup>
    </div>
  );
}
