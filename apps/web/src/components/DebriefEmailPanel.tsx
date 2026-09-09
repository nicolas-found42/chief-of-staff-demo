import { useGoogleConnection } from "../useGoogleConnection";
import { runsApi } from "../clients/workspace";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type {
  MeetingDebriefDetail,
  MeetingDebriefEmailOptions,
  MeetingDebriefEmailPreview,
  PersonProfile,
} from "@chief-of-staff-demo/shared";
import { meetingsApi, type MeetingsClient } from "../clients/meetings";
import { peopleApi } from "../clients/people";
import { errorMessage } from "../client";
import { formatMeetingTime } from "../display";

interface LocalEmailChoices {
  version: 1;
  open: boolean;
  step: 1 | 2;
  entries: { email: string; displayName: string }[];
  rosterDirty: boolean;
  dirty: boolean;
  selected: string[] | null;
  preview: MeetingDebriefEmailPreview | null;
  options: MeetingDebriefEmailOptions | null;
}

function savedChoices(key: string): LocalEmailChoices | null {
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as Omit<LocalEmailChoices, "version"> & { version: number };
    return value.version === 1 && Array.isArray(value.entries) ? { ...value, version: 1 } : null;
  } catch {
    return null;
  }
}

export function DebriefEmailPanel({
  detail,
  refresh,
  client = meetingsApi,
}: {
  detail: MeetingDebriefDetail;
  refresh: () => Promise<void>;
  client?: MeetingsClient;
}) {
  const { status: googleStatus } = useGoogleConnection();
  const storageKey = `debrief-email:${detail.runId}`;
  const [saved] = useState(() => savedChoices(storageKey));
  const [open, setOpen] = useState(saved?.open ?? false);
  const [step, setStep] = useState<1 | 2>(saved?.step ?? 1);
  const [entries, setEntries] = useState(
    () =>
      saved?.entries ??
      (detail.review?.roster.entries.length ? detail.review.roster.entries : detail.roster).map(
        (entry) => ({ email: entry.email, displayName: entry.displayName ?? "" }),
      ),
  );
  const [rosterDirty, setRosterDirty] = useState(saved?.rosterDirty ?? false);
  const [dirty, setDirty] = useState(saved?.dirty ?? false);
  const [options, setOptions] = useState<MeetingDebriefEmailOptions | null>(saved?.options ?? null);
  const [selected, setSelected] = useState<string[] | null>(saved?.selected ?? null);
  const [preview, setPreview] = useState<MeetingDebriefEmailPreview | null>(saved?.preview ?? null);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<PersonProfile[]>([]);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const review = detail.review;
  useEffect(() => {
    if (
      notice === "Draft creation requested. Checking the result…" &&
      detail.status === "done" &&
      !detail.review?.approvedAt
    ) {
      setNotice(
        "No draft was created. Inputs or prerequisites changed; update the preview before trying again.",
      );
    }
  }, [detail.status, detail.review?.approvedAt, notice]);
  useEffect(() => {
    const choices: LocalEmailChoices = {
      version: 1,
      open,
      step,
      entries,
      rosterDirty,
      dirty,
      selected,
      preview,
      options,
    };
    if (open) sessionStorage.setItem(storageKey, JSON.stringify(choices));
    else sessionStorage.removeItem(storageKey);
  }, [storageKey, open, step, entries, rosterDirty, dirty, selected, preview, options]);

  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open, step]);
  useEffect(() => {
    if (!dirty || !open) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const leave = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest("a") : null;
      if (
        target &&
        !target.getAttribute("href")?.startsWith("#") &&
        target.getAttribute("target") !== "_blank" &&
        !window.confirm("Discard unsaved email choices?")
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", leave, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", leave, true);
    };
  }, [dirty, open]);
  const act = async (operation: () => Promise<void>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const loadOptions = async () => {
    const next = await client.meetingDebriefEmailOptions(detail.runId);
    setOptions(next);
    const compatible =
      selected === null
        ? next.candidates
            .filter((candidate) => candidate.includedByDefault)
            .map((candidate) => candidate.id)
        : selected.filter((id) => next.candidates.some((candidate) => candidate.id === id));
    setSelected(compatible);
    return compatible;
  };
  const close = () => {
    if (dirty && !window.confirm("Discard unsaved email choices?")) return;
    setOpen(false);
    setDirty(false);
    setPreview(null);
    setSelected(null);
    setStep(1);
    setEntries(
      (detail.review?.roster.entries.length ? detail.review.roster.entries : detail.roster).map(
        (entry) => ({ email: entry.email, displayName: entry.displayName ?? "" }),
      ),
    );
    setRosterDirty(false);
    trigger.current?.focus();
  };
  if (!review) return null;
  if (review.approvedAt && !review.draft) {
    const held = review.email ?? preview;
    return (
      <section aria-label="Email draft">
        <p role="status">
          {detail.status === "failed"
            ? "Draft creation failed. Your reviewed preview is preserved."
            : "Creating draft… This page updates automatically."}
        </p>
        {error && <p role="alert">{error}</p>}
        {held && (
          <>
            <h4>Recipients</h4>
            <p>{held.to.join(", ")}</p>
            <h4>Subject</h4>
            <p>{held.subject}</p>
            <pre className="email-preview" aria-label="Email body preview">
              {held.body}
            </pre>
          </>
        )}
        {detail.status === "failed" && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await runsApi.retry(detail.runId);
                await refresh();
              })
            }
          >
            Retry draft creation
          </button>
        )}
        <p className="muted">
          Content and recipients remain locked for this attempt. Canonical Action Item review
          remains available. <Link to="/settings">Check the Google connection</Link>
        </p>
      </section>
    );
  }

  if (review.draft)
    return (
      <section aria-label="Email draft">
        <p role="status">
          Draft created
          {review.draft.createdAt
            ? ` · ${formatMeetingTime(review.draft.createdAt)}`
            : review.approvedAt
              ? ` · approved ${formatMeetingTime(review.approvedAt)}`
              : ""}
          .
        </p>
        <p>
          <a href={review.draft.url} target="_blank" rel="noreferrer">
            Open draft in Gmail
          </a>
        </p>
        <p className="muted">
          Nothing has been sent. Gmail edits do not update this stored Debrief. Content and
          recipients are locked; Action Item review remains available.
        </p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act(async () => {
              const next = await client.meetingDebriefRedo(detail.runId);
              window.location.assign(`/meeting-debrief/${encodeURIComponent(next.runId)}`);
            })
          }
        >
          Start a new Debrief
        </button>
        <p className="muted">Creates a separate version and can lead to another draft.</p>
      </section>
    );
  return (
    <section aria-label="Email draft">
      <button
        ref={trigger}
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          void act(async () => {
            await loadOptions();
          });
        }}
      >
        Create email draft
      </button>
      {open && (
        <div
          className="card email-panel"
          role="region"
          aria-label="Prepare email draft"
          aria-busy={busy}
        >
          <div className="toolbar">
            {step === 2 && (
              <button type="button" disabled={busy} onClick={() => setStep(1)}>
                Back
              </button>
            )}
            <button type="button" disabled={busy} onClick={close}>
              Cancel
            </button>
          </div>
          <h3 ref={heading} tabIndex={-1}>
            {step === 1 ? "Attendees and recipients" : "Preview and create"}
          </h3>
          {error && <p role="alert">{error}</p>}
          {review.duplicateWarning && (
            <p role="alert">
              Duplicate output warning: this transcript already has a draft from{" "}
              <Link to={`/meeting-debrief/${review.duplicateWarning.approvedRunId}`}>
                {review.duplicateWarning.approvedRunId}
              </Link>
              . This version can create another draft.
            </p>
          )}
          <p role="status">{notice}</p>
          {googleStatus && googleStatus.state !== "connected" && (
            <p>
              Gmail requires a connected Google account.{" "}
              <Link to="/settings">Set up or reconnect Google</Link> before creating a draft.
              Reading and local Task review remain available.
            </p>
          )}
          {step === 1 ? (
            <>
              <p>
                Confirm who attended. Every confirmed attendee except you receives the draft.
                Creating a draft never sends it.
              </p>
              {entries.map((entry, index) => (
                <div className="field-row" key={index}>
                  <label htmlFor={`attendee-name-${index}`}>Attendee name {index + 1}</label>
                  <input
                    disabled={busy}
                    id={`attendee-name-${index}`}
                    value={entry.displayName}
                    onChange={(event) => {
                      setEntries(
                        entries.map((old, n) =>
                          n === index ? { ...old, displayName: event.target.value } : old,
                        ),
                      );
                      setDirty(true);
                      setRosterDirty(true);
                      setPreview(null);
                    }}
                  />
                  <label htmlFor={`attendee-email-${index}`}>Attendee email {index + 1}</label>
                  <input
                    disabled={busy}
                    id={`attendee-email-${index}`}
                    type="email"
                    value={entry.email}
                    onChange={(event) => {
                      setEntries(
                        entries.map((old, n) =>
                          n === index ? { ...old, email: event.target.value } : old,
                        ),
                      );
                      setDirty(true);
                      setRosterDirty(true);
                      setPreview(null);
                    }}
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEntries(entries.filter((_, n) => n !== index));
                      setDirty(true);
                      setRosterDirty(true);
                      setPreview(null);
                    }}
                  >
                    Remove attendee {index + 1}
                  </button>
                </div>
              ))}
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setEntries([...entries, { email: "", displayName: "" }]);
                  setDirty(true);
                  setRosterDirty(true);
                }}
              >
                Add attendee
              </button>{" "}
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    await client.meetingDebriefConfirmRoster(detail.runId, entries);
                    setRosterDirty(false);
                    setPreview(null);
                    await refresh();
                    setNotice("Attendees confirmed.");
                  })
                }
              >
                Confirm attendees
              </button>
              <h4>Additional recipients</h4>
              <p>Choose a confirmed Person Profile with a verified email.</p>
              {review.additionalRecipients.map((recipient) => (
                <p key={recipient.profileId}>
                  {recipient.email}{" "}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await client.meetingDebriefRemoveRecipient(
                          detail.runId,
                          recipient.profileId,
                        );
                        setPreview(null);
                        await refresh();
                      })
                    }
                  >
                    Remove recipient
                  </button>
                </p>
              ))}
              <label htmlFor="email-profile-search">Find a Person Profile</label>
              <input
                disabled={busy}
                id="email-profile-search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <button
                type="button"
                disabled={busy}
                onClick={() => void act(async () => setPeople(await peopleApi.people(query)))}
              >
                Search profiles
              </button>
              <ul>
                {people.map((person) => (
                  <li key={person.id}>
                    {person.fullName ?? person.id} · {person.primaryEmail ?? "No email"}{" "}
                    <button
                      type="button"
                      disabled={busy || !person.primaryEmail}
                      onClick={() =>
                        void act(async () => {
                          await client.meetingDebriefAddRecipient(detail.runId, {
                            profileId: person.id,
                            email: person.primaryEmail!,
                          });
                          setPreview(null);
                          await refresh();
                        })
                      }
                    >
                      Add recipient
                    </button>
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setStep(2);
                  void act(async () => {
                    await loadOptions();
                  });
                }}
              >
                Preview and create
              </button>
            </>
          ) : (
            <>
              <p>
                Choose commitments for this email. These choices do not change Tasks or Action Item
                review.
              </p>
              {options?.unavailableReview && (
                <p role="status">
                  Some canonical review states are unavailable. Review the explicit selections below
                  before proceeding.
                </p>
              )}
              <ul>
                {options?.candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <label>
                      <input
                        disabled={busy}
                        type="checkbox"
                        checked={selected?.includes(candidate.id) ?? false}
                        onChange={(event) => {
                          setSelected(
                            event.target.checked
                              ? [...(selected ?? []), candidate.id]
                              : (selected ?? []).filter((id) => id !== candidate.id),
                          );
                          setDirty(true);
                          setPreview(null);
                        }}
                      />{" "}
                      {candidate.title}
                    </label>
                    <span className="muted">
                      {" "}
                      · {candidate.owner ?? "Unassigned"}
                      {candidate.dueDate ? ` · ${candidate.dueDate}` : ""}
                      {candidate.earlier ? " · Earlier proposal" : ""} ·{" "}
                      {candidate.reviewState === "unavailable"
                        ? "Review state unavailable"
                        : candidate.reviewState}
                    </span>
                  </li>
                ))}
              </ul>
              {rosterDirty && (
                <p role="alert">
                  Confirm the changed attendees in the previous step before previewing.
                </p>
              )}
              {review.approvalBlockers.length > 0 && (
                <div>
                  <p>Before creating a draft:</p>
                  <ul>
                    {review.approvalBlockers.map((blocker) => (
                      <li key={blocker}>
                        {blocker === "owner-identity-unconfirmed" ? (
                          <Link to="/settings">Confirm your owner identity in Settings</Link>
                        ) : blocker === "roster-unconfirmed" ? (
                          "Confirm attendees in the previous step."
                        ) : (
                          <>
                            <Link to="/people">Verify the attendee's Person Profile email</Link>:{" "}
                            {blocker.replace("attendee-unverified-email:", "")}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <button
                type="button"
                disabled={busy || rosterDirty || selected === null}
                onClick={() =>
                  void act(async () => {
                    const compatible = await loadOptions();
                    const result = await client.meetingDebriefEmailPreview(
                      detail.runId,
                      compatible,
                    );
                    setPreview(result);
                    setNotice(
                      "Preview updated. Review the subject, recipients and body before creating the draft.",
                    );
                  })
                }
              >
                Update preview
              </button>
              {preview && (
                <div>
                  <h4>Recipients</h4>
                  <p>{preview.to.join(", ") || "No recipients"}</p>
                  <h4>Subject</h4>
                  <p>{preview.subject}</p>
                  <h4>Email body</h4>
                  <pre className="email-preview" aria-label="Email body preview">
                    {preview.body}
                  </pre>
                  <button
                    type="button"
                    disabled={busy || rosterDirty || review.approvalBlockers.length > 0}
                    onClick={() =>
                      void act(async () => {
                        await client.meetingDebriefApprove(detail.runId, preview);
                        setDirty(false);
                        await refresh();
                        setNotice("Draft creation requested. Checking the result…");
                      })
                    }
                  >
                    Create draft in Gmail
                  </button>
                  <p className="muted">Creates a draft only. You send it from Gmail.</p>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
