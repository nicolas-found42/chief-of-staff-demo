import { useCallback, useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { errorMessage } from "../client";
import { migrationApi, type MigrationStatus, type OnboardingStep } from "../clients/workspace";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";

/** Goal-addressable setup: the Meeting path is independent from general Workspace setup. */
export function OnboardingSetupPage() {
  const [params] = useSearchParams();
  const goal = params.get("goal") === "meetings" ? "meetings" : "general";
  useTitle(goal === "meetings" ? "Meeting setup" : "Set up your workspace");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const [status, setStatus] = useState<MigrationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await migrationApi.status(goal));
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [goal]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [refresh]);

  const onboarding = status?.onboarding;
  const origin = status?.origin ?? "pristine";
  const renderStep = (step: OnboardingStep) => (
    <li key={step.id}>
      <Link to={step.href}>{step.label}</Link>{" "}
      <span className={step.done ? "ok" : "muted"}>{step.done ? "Done" : "To do"}</span>
    </li>
  );

  return (
    <div className="page">
      <h1 ref={focusRef} tabIndex={-1}>
        {goal === "meetings" ? "Meeting setup" : "Set up your workspace"}
      </h1>
      {origin === "migrated" ? (
        <p className="muted">
          This Workspace completed the canonical cutover. Preserved work, historical Runs, and
          Workspace settings remain available. Installation Credentials now live outside the
          Workspace.
        </p>
      ) : (
        <p className="muted">
          This is a new Workspace. Complete the steps below when you are ready to use its products.
        </p>
      )}
      {goal === "meetings" ? (
        <p className="muted">
          These five independent prerequisites lead to a first Meeting Debrief. Other product setup
          stays separate.
        </p>
      ) : null}

      {error && (
        <div className="banner banner-error" role="alert">
          {error}
        </div>
      )}

      {status === null ? (
        <p className="muted">Loading…</p>
      ) : !onboarding ? (
        <p className="muted" role="status">
          Setup status is unavailable.
        </p>
      ) : onboarding.complete ? (
        <>
          <p className="banner banner-ok" role="status">
            {goal === "meetings" ? "Meeting setup complete" : "Onboarding complete"}
          </p>
          {goal === "meetings" ? (
            <section className="card" aria-label="Other product setup">
              <p>
                {onboarding.otherSetup?.complete
                  ? "Other product setup is still optional."
                  : "Other product setup is optional and does not block Meeting Debriefs."}
              </p>
            </section>
          ) : null}
          <p>
            <Link to="/" className="action-button">
              Go to Home
            </Link>
          </p>
        </>
      ) : (
        <>
          <section
            className="card"
            aria-label={
              goal === "meetings" ? "Required for your first Meeting Debrief" : "Workspace setup"
            }
          >
            <h2>{goal === "meetings" ? "Required for your first Meeting Debrief" : "Steps"}</h2>
            <ul className="setup-check-list">{onboarding.steps.map(renderStep)}</ul>
          </section>
          {goal === "meetings" && onboarding.otherSetup ? (
            <section className="card" aria-label="Other product setup">
              <h2>Other product setup</h2>
              <p>Other product setup is optional and does not block Meeting Debriefs.</p>
              <ul className="setup-check-list">
                {onboarding.otherSetup.steps.map((step) => (
                  <li key={step.id}>
                    <Link to={step.href}>{step.label}</Link>{" "}
                    <span className={step.done ? "ok" : "muted"}>
                      {step.done ? "Done" : "Optional"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}

      {goal === "general" && onboarding?.guidedSetup && (
        <details className="disclosure">
          <summary>Ten local Guided Setup stages</summary>
          <div className="disclosure-body">
            <p>
              Run <code>./scripts/setup-wizard.sh</code> on this installation. Backup and migration
              stages are verified by the local command; the app cannot inspect the operator's
              private backup.
            </p>
            <ol className="setup-check-list">
              {onboarding.guidedSetup.stages.map((stage) => (
                <li key={stage.id}>
                  {stage.href ? <Link to={stage.href}>{stage.label}</Link> : stage.label}{" "}
                  <span className={stage.state === "confirmed" ? "ok" : "muted"}>
                    {stage.state === "operator-check"
                      ? "Check in local setup"
                      : stage.state === "to-do"
                        ? "To do"
                        : stage.state === "waiting"
                          ? "Waiting"
                          : stage.state === "unavailable"
                            ? "Unavailable"
                            : "Confirmed"}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </details>
      )}
    </div>
  );
}
