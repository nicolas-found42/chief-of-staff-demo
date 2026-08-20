import { useModules } from "../useModules";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

export function HotTakePage() {
  useTitle("Hot Take");
  const headingRef = usePageFocus<HTMLHeadingElement>();
  /* Read from the shared Module list rather than asserted here, so this page and
     Home's card cannot end up describing the same Module differently. */
  const planned = useModules().some(
    (module) => module.id === "hot-take" && module.status === "planned"
  );

  return (
    <div className="page">
      <h1 ref={headingRef} tabIndex={-1}>
        Hot Take {planned && <span className="status-pill status-active">Planned</span>}
      </h1>
      <p className="muted">
        Turn a link or transcript into a draft LinkedIn post. This Module is planned — Runs, Intakes
        and Output Adapters will land next.
      </p>
      <div className="card">
        <h2>Planned</h2>
        <ul>
          <li>
            <strong>Intake:</strong> link / transcript upload <span className="muted">(planned)</span>
          </li>
          <li>
            <strong>Output:</strong> draft doc <span className="muted">(planned)</span>
          </li>
        </ul>
      </div>
      <p className="muted">This tab exercises the Module registry seam (ADR-0002) ahead of the build.</p>
    </div>
  );
}
