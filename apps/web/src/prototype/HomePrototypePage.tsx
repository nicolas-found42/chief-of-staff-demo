/* PROTOTYPE — throwaway. Three variants of Home on ?variant=A|B|C, with
   ?state=live|fresh|busy so first-run and failure states are reachable without
   arranging a real workspace. Branch prototype/home-variants, never main.
   Answers .scratch/shell-home/issues/01-what-home-shows.md */
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import type { GoogleStatus, RunSummary } from "@chief-of-staff-demo/shared";
import { StatusPill, formatTime } from "../components/StatusPill";
import { api } from "../client";
import { PrototypeSwitcher } from "./PrototypeSwitcher";

/* The shared Module list ticket 04 will decide the real shape of. Guessed here
   only so the variants have something to render. */
const MODULES = [
  {
    id: "transcript",
    label: "Transcript → Tasks",
    path: "/",
    planned: false,
    blurb: "Meeting transcripts become Google Tasks and Gmail drafts.",
  },
  {
    id: "hot-take",
    label: "Hot Take",
    path: "/hot-take",
    planned: true,
    blurb: "A link or transcript becomes a draft LinkedIn post.",
  },
];

const STUBS: Record<string, { runs: RunSummary[]; google: GoogleStatus }> = {
  fresh: {
    runs: [],
    google: {
      state: "unconfigured",
      email: null,
      redirectUri: "http://localhost:4317/api/google/callback",
      scopes: [],
      lastConnectedAt: null,
      expiresAbout: null,
    } as GoogleStatus,
  },
  quiet: {
    runs: [
      { id: "q3", createdAt: new Date(Date.now() - 8e6).toISOString(), source: "watch", fileName: "Weekly 1-1.txt", sourceUrl: null, status: "done", taskCount: 4 },
      { id: "q2", createdAt: new Date(Date.now() - 9e7).toISOString(), source: "watch", fileName: "Board sync.txt", sourceUrl: null, status: "done", taskCount: 6 },
      { id: "q1", createdAt: new Date(Date.now() - 1.8e8).toISOString(), source: "upload", fileName: "Client call.docx", sourceUrl: null, status: "done", taskCount: 2 },
    ],
    google: {
      state: "connected",
      email: "nicolas@found42.com",
      redirectUri: "http://localhost:4317/api/google/callback",
      scopes: [],
      lastConnectedAt: new Date(Date.now() - 2e8).toISOString(),
      expiresAbout: new Date(Date.now() + 4e8).toISOString(),
    } as GoogleStatus,
  },
  busy: {
    runs: [
      { id: "r5", createdAt: new Date(Date.now() - 6e5).toISOString(), source: "watch", fileName: "Board sync 2026-08-20.txt", sourceUrl: null, status: "running", taskCount: null },
      { id: "r4", createdAt: new Date(Date.now() - 36e5).toISOString(), source: "upload", fileName: "Pricing call.docx", sourceUrl: null, status: "failed", taskCount: null },
      { id: "r3", createdAt: new Date(Date.now() - 9e6).toISOString(), source: "fireflies", fileName: "EdgeScale kickoff", sourceUrl: null, status: "done", taskCount: 7 },
      { id: "r2", createdAt: new Date(Date.now() - 9e7).toISOString(), source: "upload", fileName: "notes-scratch.md", sourceUrl: null, status: "skipped", taskCount: null },
      { id: "r1", createdAt: new Date(Date.now() - 1.7e8).toISOString(), source: "watch", fileName: "Weekly 1-1.txt", sourceUrl: null, status: "done", taskCount: 3 },
    ],
    google: {
      state: "connected",
      email: "nicolas@found42.com",
      redirectUri: "http://localhost:4317/api/google/callback",
      scopes: [],
      lastConnectedAt: new Date(Date.now() - 5.7e8).toISOString(),
      expiresAbout: new Date(Date.now() + 7e7).toISOString(),
    } as GoogleStatus,
  },
};

export function HomePrototypePage() {
  const [params] = useSearchParams();
  const variant = params.get("variant") ?? "D";
  const state = params.get("state") ?? "busy";
  const [live, setLive] = useState<{ runs: RunSummary[]; google: GoogleStatus | null }>({ runs: [], google: null });

  useEffect(() => {
    if (state !== "live") return;
    void (async () => {
      const [runs, google] = await Promise.all([
        api.listRuns().then((p) => p.runs).catch(() => []),
        api.googleStatus().catch(() => null),
      ]);
      setLive({ runs, google });
    })();
  }, [state]);

  const data = state === "live" ? live : STUBS[state];
  const runs = data.runs;
  const google = data.google;

  const failed = runs.filter((r) => r.status === "failed");
  const active = runs.filter((r) => r.status === "pending" || r.status === "running");
  const props = { runs, google, failed, active };

  return (
    <>
      {variant === "A" && <VariantA {...props} />}
      {variant === "B" && <VariantB {...props} />}
      {variant === "C" && <VariantC {...props} />}
      {variant === "D" && <VariantD {...props} />}
      <PrototypeSwitcher
        variants={["D", "A", "B", "C"]}
        names={{ D: "Composite (chosen)", A: "Standing report (prose)", B: "Attention rail + grid", C: "Module-first board" }}
        states={["busy", "quiet", "fresh", "live"]}
      />
    </>
  );
}

/* ---------- D: composite — A's sentence over B's rail + grid, no Recent list.
   The rail is omitted entirely when empty rather than showing a green
   all-clear, because the sentence above has already said it. ---------- */
function VariantD({ runs, google, failed, active }: Props) {
  const items: { text: string; to: string; cta: string }[] = [];
  for (const run of failed) {
    items.push({ text: `${run.fileName} failed`, to: `/runs/${run.id}`, cta: "Open" });
  }
  if (google && google.state !== "connected") {
    items.push({
      text:
        google.state === "unconfigured"
          ? "Google is not set up, so runs have nowhere to put tasks"
          : "Google needs signing in again",
      to: "/settings",
      cta: google.state === "unconfigured" ? "Set up" : "Sign in",
    });
  }

  /* The sentence enumerates; the rail itemises. Summary over detail, so Home
     always opens with one line telling you where you stand, in a fixed spot. */
  const clauses: string[] = [];
  if (failed.length > 0) {
    clauses.push(`${failed.length} run${failed.length === 1 ? "" : "s"} failed`);
  }
  if (google && google.state !== "connected") {
    clauses.push(google.state === "unconfigured" ? "Google is not set up" : "Google needs signing in again");
  }

  const sentence =
    clauses.length > 0
      ? `${runs.length === 0 ? "Nothing has run yet. " : ""}${join(clauses)}.`
      : runs.length === 0
        ? "Nothing has run yet."
        : active.length > 0
          ? `${active.length} run${active.length === 1 ? "" : "s"} in progress. Nothing needs you.`
          : "All quiet. Nothing needs you.";

  return (
    <div className="page">
      <h1>Home</h1>
      <p style={{ fontSize: "1.35rem", lineHeight: 1.5, maxWidth: "44ch", marginTop: "-.25rem", marginBottom: ".4rem" }}>
        {sentence}
      </p>

      {/* The one fact where "no news" is genuinely ambiguous: silence cannot be
          told apart from a check that never happened, and this connection
          expires about weekly. */}
      {google?.state === "connected" && (
        <p className="muted" style={{ marginTop: 0, marginBottom: "2rem" }}>
          Google connected{google.email ? ` as ${google.email}` : ""}
        </p>
      )}

      {items.length > 0 && (
        <ul style={{ listStyle: "none", padding: 0, margin: "0 0 2.5rem" }}>
          {items.map((item) => (
            <li key={item.text} className="banner banner-warn" style={{ marginBottom: ".5rem" }}>
              <span>{item.text}</span>
              <Link to={item.to} className="step-link">
                {item.cta}
              </Link>
            </li>
          ))}
        </ul>
      )}

      <h2>Modules</h2>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: "1rem" }}>
        {MODULES.map((m) => (
          <div className="card" key={m.id}>
            <h3 style={{ margin: "0 0 .35rem" }}>
              <Link to={m.path}>{m.label}</Link>
              {m.planned && <span className="status-pill status-active" style={{ marginLeft: 8 }}>Planned</span>}
            </h3>
            <p className="muted" style={{ margin: 0 }}>{m.blurb}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Props {
  runs: RunSummary[];
  google: GoogleStatus | null;
  failed: RunSummary[];
  active: RunSummary[];
}

/* ---------- A: the page is a sentence. Prose-led, modules secondary. ---------- */
function VariantA({ runs, google, failed, active }: Props) {
  const sentence =
    runs.length === 0
      ? "Nothing has run yet."
      : failed.length > 0
        ? `${failed.length} run${failed.length === 1 ? "" : "s"} failed and ${failed.length === 1 ? "is" : "are"} waiting for you.`
        : active.length > 0
          ? `${active.length} run${active.length === 1 ? "" : "s"} in progress. Nothing needs you.`
          : "All quiet. Nothing needs you.";

  return (
    <div className="page">
      <h1>Chief of Staff</h1>
      <p style={{ fontSize: "1.35rem", lineHeight: 1.5, maxWidth: "44ch" }}>
        {sentence}{" "}
        {failed.length > 0 && (
          <Link to={`/runs/${failed[0].id}`} className="step-link">
            Open the first one
          </Link>
        )}
        {runs.length === 0 && google?.state === "unconfigured" && (
          <>
            Connect Google in{" "}
            <Link to="/settings" className="step-link">
              Settings
            </Link>{" "}
            and drop a transcript to begin.
          </>
        )}
      </p>

      {runs.length > 0 && (
        <p className="muted">
          {runs.length} run{runs.length === 1 ? "" : "s"} recorded · last activity{" "}
          {formatTime(runs[0].createdAt)} ·{" "}
          <Link to="/" className="step-link">
            see all runs
          </Link>
        </p>
      )}

      <h2 style={{ marginTop: "2.5rem" }}>Modules</h2>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {MODULES.map((m) => (
          <li key={m.id} style={{ marginBottom: "1rem" }}>
            <Link to={m.path} className="step-link" style={{ fontSize: "1.1rem" }}>
              {m.label}
            </Link>
            {m.planned && <span className="status-pill status-active" style={{ marginLeft: 8 }}>Planned</span>}
            <div className="muted">{m.blurb}</div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- B: attention queue is primary; modules a grid beside it. ---------- */
function VariantB({ runs, google, failed, active }: Props) {
  const items: { text: string; to: string; cta: string }[] = [];
  for (const run of failed) {
    items.push({ text: `${run.fileName} failed`, to: `/runs/${run.id}`, cta: "Retry" });
  }
  if (google && google.state !== "connected") {
    items.push({
      text:
        google.state === "unconfigured"
          ? "Google is not set up, so runs have nowhere to put tasks"
          : "Google needs signing in again",
      to: "/settings",
      cta: google.state === "unconfigured" ? "Set up" : "Sign in",
    });
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Home</h1>
        <span className="muted">
          {active.length > 0 ? `${active.length} in progress` : "Idle"}
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.4fr) minmax(0,1fr)", gap: "2rem", alignItems: "start" }}>
        <section>
          <h2>Needs you</h2>
          {items.length === 0 ? (
            <div className="banner banner-ok" role="status">
              <span>All clear — nothing needs you.</span>
            </div>
          ) : (
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {items.map((item) => (
                <li key={item.text} className="banner banner-warn" style={{ marginBottom: ".5rem" }}>
                  <span>{item.text}</span>
                  <Link to={item.to} className="step-link">
                    {item.cta}
                  </Link>
                </li>
              ))}
            </ul>
          )}

          <h2 style={{ marginTop: "2rem" }}>Recent</h2>
          {runs.length === 0 ? (
            <p className="muted">No runs yet.</p>
          ) : (
            <ul style={{ listStyle: "none", padding: 0 }}>
              {runs.slice(0, 4).map((run) => (
                <li key={run.id} style={{ display: "flex", gap: 10, alignItems: "center", padding: ".4rem 0", borderBottom: "1px solid rgba(0,0,0,.07)" }}>
                  <StatusPill status={run.status} />
                  <Link to={`/runs/${run.id}`} className="run-link" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {run.fileName}
                  </Link>
                  <span className="muted">{run.taskCount ?? "—"}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2>Modules</h2>
          {MODULES.map((m) => (
            <div className="card" key={m.id} style={{ marginBottom: "1rem" }}>
              <h3 style={{ margin: "0 0 .35rem" }}>
                <Link to={m.path}>{m.label}</Link>
                {m.planned && <span className="status-pill status-active" style={{ marginLeft: 8 }}>Planned</span>}
              </h3>
              <p className="muted" style={{ margin: 0 }}>{m.blurb}</p>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}

/* ---------- C: modules are the page; status distributed into each. ---------- */
function VariantC({ runs, failed, active }: Props) {
  const done = runs.filter((r) => r.status === "done");
  const tasks = done.reduce((sum, r) => sum + (r.taskCount ?? 0), 0);

  return (
    <div className="page">
      <h1 className="visually-hidden">Home</h1>
      <div style={{ display: "grid", gap: "1.25rem" }}>
        <section className="card" style={{ borderLeft: "4px solid #2d7" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>
              <Link to="/">Transcript → Tasks</Link>
            </h2>
            <span className="muted">{MODULES[0].blurb}</span>
          </div>
          <div style={{ display: "flex", gap: "2rem", marginTop: "1rem", flexWrap: "wrap" }}>
            <Metric label="In progress" value={active.length} />
            <Metric label="Failed" value={failed.length} bad={failed.length > 0} />
            <Metric label="Runs" value={runs.length} />
            <Metric label="Tasks created" value={tasks} />
          </div>
          {failed.length > 0 && (
            <p style={{ marginBottom: 0, marginTop: "1rem" }}>
              <Link to={`/runs/${failed[0].id}`} className="step-link">
                {failed[0].fileName} failed — open it
              </Link>
            </p>
          )}
          {runs.length === 0 && (
            <p className="muted" style={{ marginBottom: 0, marginTop: "1rem" }}>
              Nothing has run yet. Drop a transcript on the Transcript tab to begin.
            </p>
          )}
        </section>

        <section className="card" style={{ borderLeft: "4px solid rgba(0,0,0,.15)", opacity: 0.75 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
            <h2 style={{ margin: 0 }}>
              <Link to="/hot-take">Hot Take</Link>{" "}
              <span className="status-pill status-active">Planned</span>
            </h2>
            <span className="muted">{MODULES[1].blurb}</span>
          </div>
          <p className="muted" style={{ marginBottom: 0, marginTop: "1rem" }}>
            Not built yet — nothing to report.
          </p>
        </section>
      </div>
    </div>
  );
}

function join(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")}, and ${parts[parts.length - 1]}`;
}

function Metric({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: "1.9rem", lineHeight: 1, fontWeight: 600, color: bad ? "#c22" : undefined }}>
        {value}
      </div>
      <div className="muted" style={{ fontSize: ".85rem" }}>{label}</div>
    </div>
  );
}
