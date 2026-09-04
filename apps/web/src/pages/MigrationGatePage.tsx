import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { errorMessage } from "../client";
import {
  migrationApi,
  type MigrationInventory,
  type MigrationInventoryCategory,
  type MigrationReceipt,
} from "../clients/workspace";
import { usePageFocus } from "../usePageFocus";
import { useTitle } from "../useTitle";
/**
 * The exact phrase the reset demands (spec: Migration and Cutover, step 3).
 * The server compares it exactly, like every other destructive confirmation
 * in this Workspace ("DELETE PROFILE", "DELETE TRANSCRIPT"), against
 * MIGRATION_CONFIRMATION_PHRASE in apps/server/src/migration/workspace.ts.
 */
const MIGRATION_CONFIRMATION_PHRASE = "RESET WORKSPACE";

/**
 * The one-time, gated cutover screen (spec: Migration and Cutover). It
 * enumerates every deletion and auth-preservation category from the read-only
 * preview — names and counts, never content — and requires a typed
 * confirmation before the reset runs.
 *
 * Cancelling is a client no-op by contract: no request is sent, and the
 * Workspace is left byte-for-byte unchanged. Confirming shows the content-free
 * receipt briefly, then hands over to onboarding.
 */
export function MigrationGatePage({ onCutOver }: { onCutOver: () => void }) {
  useTitle("Workspace migration");
  const focusRef = usePageFocus<HTMLHeadingElement>();
  const navigate = useNavigate();
  const [inventory, setInventory] = useState<MigrationInventory | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<MigrationReceipt | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    let live = true;
    migrationApi
      .inventory()
      .then((payload) => {
        if (live) setInventory(payload);
      })
      .catch((err) => {
        if (live) setLoadError(errorMessage(err));
      });
    return () => {
      live = false;
    };
  }, []);

  /* The error is announced by role="alert"; moving focus onto it makes the
     failure the next thing a keyboard user meets, not the button they pressed. */
  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  /* The receipt is shown briefly — the reset is already done at this point —
     and then the Shell hands over to onboarding. Navigating first moves the
     URL under the route the product shell will hold; `onCutOver` then re-reads
     the migration status so the Shell swaps the gate for the product routes
     (the boot gate reads status once — only this seam knows the cutover
     happened in-process). */
  useEffect(() => {
    if (receipt === null) return;
    const timer = setTimeout(() => {
      void navigate("/onboarding", { replace: true });
      onCutOver();
    }, 2500);
    return () => clearTimeout(timer);
  }, [receipt, navigate, onCutOver]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { receipt: confirmed } = await migrationApi.confirm(typed);
      setReceipt(confirmed);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const categories = inventory?.outcome === "inventory" ? inventory.categories : [];
  const preserved = categories.filter((category) => category.classification === "authentication");
  const deleted = categories.filter(
    (category) => category.classification === "disposable-product-state",
  );
  const remoteRecords = inventory?.outcome === "inventory" ? inventory.remoteRecords : [];

  return (
    <div className="page">
      <h1 ref={focusRef} tabIndex={-1}>
        Workspace migration
      </h1>

      {receipt !== null ? (
        <section className="card">
          <h2>Migration complete</h2>
          <p className="muted">Taking you to onboarding…</p>
          <dl className="receipt-grid">
            {(
              [
                ["Directories removed", receipt.categories.directories],
                ["Files removed", receipt.categories.files],
                ["Credentials preserved", receipt.categories.preservedConfigKeys],
                ["Config keys removed", receipt.categories.droppedConfigKeys],
                ["Relay keys preserved", receipt.categories.preservedRelayKeys],
                ["Relay keys removed", receipt.categories.droppedRelayKeys],
              ] as const
            ).map(([label, value]) => (
              <div className="receipt-row" key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : (
        <>
          <p className="muted">
            This Workspace holds pre-cutover product data. One confirmation deletes every local
            product datum and non-auth setting, preserves every provider credential, and starts
            onboarding. No backup is created.
          </p>

          {error && (
            <p className="banner-error" role="alert" ref={errorRef} tabIndex={-1}>
              {error}
            </p>
          )}

          {inventory?.outcome === "unsafe-mixed-state" && (
            <section className="card">
              <h2>Cannot migrate — ambiguous state</h2>
              <p>
                Authentication and product state could not be separated safely, so the reset deleted
                nothing and will not run until the entries below are resolved.
              </p>
              <ul className="setup-check-list">
                {inventory.findings.map((finding, index) => (
                  <li key={`${finding.entry}:${finding.key ?? ""}:${index}`}>
                    <code>{finding.entry}</code>
                    {finding.key !== null && (
                      <>
                        {" "}
                        key <code>{finding.key}</code>
                      </>
                    )}{" "}
                    — {finding.reason}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {loadError && (
            <div className="banner banner-error" role="alert">
              {loadError === "not-required"
                ? "No migration is needed for this Workspace."
                : loadError}
            </div>
          )}

          {categories.length > 0 && (
            <>
              <section className="card">
                <h2>Deleted</h2>
                <p className="muted">
                  Every local product datum and non-auth configuration, in these categories.
                </p>
                <CategoryList categories={deleted} />
              </section>

              <section className="card">
                <h2>Preserved</h2>
                <p className="muted">
                  Authentication material for every provider, so nothing has to be reconnected.
                </p>
                <CategoryList categories={preserved} />
              </section>

              <section className="card">
                <h2>Untouched</h2>
                <p className="muted">
                  Provider-owned records that local values merely name. The values are deleted with
                  their category; the records themselves are never touched.
                </p>
                <ul className="setup-check-list">
                  {remoteRecords.map((record) => (
                    <li key={record.name}>
                      <code>{record.name}</code> — {record.count} named locally
                    </li>
                  ))}
                </ul>
              </section>

              <section className="card">
                <h2>Confirm</h2>
                <form onSubmit={(event) => void submit(event)}>
                  <p>
                    <label htmlFor="migration-confirmation">
                      Type <code>{MIGRATION_CONFIRMATION_PHRASE}</code> to confirm
                    </label>
                    <input
                      id="migration-confirmation"
                      type="text"
                      autoComplete="off"
                      value={typed}
                      onChange={(event) => setTyped(event.target.value)}
                    />
                  </p>
                  <button className="action-button primary" type="submit" disabled={busy}>
                    {busy ? "Deleting…" : "Confirm and reset"}
                  </button>{" "}
                  <button
                    className="action-button"
                    type="button"
                    onClick={() => void navigate("/")}
                    disabled={busy}
                  >
                    Cancel and keep this Workspace
                  </button>
                  <p className="field-hint">
                    Cancelling is a client-only action: no request is sent, and the Workspace is
                    left byte-for-byte unchanged.
                  </p>
                </form>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}

/** The preview's category names verbatim, with their counts. Content-free by construction. */
function CategoryList({ categories }: { categories: MigrationInventoryCategory[] }) {
  return (
    <ul className="setup-check-list">
      {categories.map((category) => (
        <li key={category.name}>
          <code>{category.name}</code> — {category.count}
        </li>
      ))}
    </ul>
  );
}
