import type { ContentScoutRunResult, RunDetail } from "@chief-of-staff-demo/shared";

export function ContentScoutResultView({ detail }: { detail: RunDetail }) {
  const result = detail.result as ContentScoutRunResult | null;
  if (!result) return null;
  return (
    <section aria-labelledby="content-scout-receipt">
      <h2 id="content-scout-receipt">Content Scout receipt</h2>
      {result.adapters.length > 0 && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Adapter</th>
                <th>State</th>
                <th>Targets</th>
                <th>Items</th>
                <th>Outcome</th>
                <th>Duration / retries</th>
                <th>Affected capabilities</th>
              </tr>
            </thead>
            <tbody>
              {result.adapters.map((adapter, index) => (
                <tr key={`${adapter.adapterId}-${index}`}>
                  <td>{adapter.adapterId}</td>
                  <td>{adapter.state}</td>
                  <td>{adapter.targetsAttempted}</td>
                  <td>{adapter.itemsFound}</td>
                  <td>{adapter.outcome.replaceAll("_", " ")}</td>
                  <td>
                    {adapter.durationMs} ms / {adapter.retries}
                  </td>
                  <td>{adapter.affectedCapabilities.join(", ") || "None"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        {result.shortlist.opportunityCount} shortlist opportunities ·{" "}
        {result.shortlist.omittedCount} omitted · {result.warnings} warnings
      </p>
      {result.packs?.map((pack) => (
        <div className="card" key={pack.id}>
          <strong>
            {pack.generated}/{pack.total} local drafts · {pack.published}/{pack.total} Notion pages
          </strong>
          {pack.missingDraftTargets.length > 0 && (
            <p className="field-error">Missing drafts: {pack.missingDraftTargets.join(", ")}</p>
          )}
          {pack.missingNotionPages.length > 0 && (
            <p className="field-error">Missing pages: {pack.missingNotionPages.join(", ")}</p>
          )}
        </div>
      ))}
    </section>
  );
}
