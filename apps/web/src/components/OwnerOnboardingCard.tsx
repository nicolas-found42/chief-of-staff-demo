import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { GoogleConnectionState, PersonProfile } from "@chief-of-staff-demo/shared";
import { errorMessage } from "../client";
import { onboardingApi, type OwnerOnboardingStatus } from "../clients/workspace";
import { peopleApi } from "../clients/people";

/**
 * Owner onboarding (issue #123): the connected Google identity proposes the
 * owner's canonical Person Profile; the owner explicitly selects, corrects,
 * or creates-and-confirms it. Nothing is confirmed without the button press,
 * and the pinned reference carries the exact Profile revision.
 */
/** An unnamed Profile cannot be a confirmed owner identity — the owner has no
    name to check the confirmation against (UX audit F2) — so it is neither
    offered nor auto-selected. */
const isNamedProfile = (profile: PersonProfile): boolean => (profile.fullName ?? "").trim() !== "";

export function OwnerOnboardingCard({
  googleConnectionState,
}: {
  googleConnectionState: GoogleConnectionState | null;
}) {
  const [status, setStatus] = useState<OwnerOnboardingStatus | null>(null);
  const [profiles, setProfiles] = useState<PersonProfile[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([onboardingApi.owner(), peopleApi.people()]);
      setStatus(next);
      setProfiles(list);
      /* UX audit F2: an unnamed Profile cannot be a confirmed owner identity —
         the owner has no name to check the confirmation against — so it is
         neither offered nor auto-selected. An email match on an unnamed
         Profile therefore falls through to the honest create-one path below. */
      const candidates = list.filter(isNamedProfile);
      setSelectedId((current) => {
        if (current && candidates.some((profile) => profile.id === current)) return current;
        const proposed = candidates.find(
          (profile) => profile.id === next.proposal?.matchedProfileId,
        );
        return proposed?.id ?? candidates[0]?.id ?? "";
      });
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [googleConnectionState, refresh]);

  const confirm = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(null);
    try {
      await onboardingApi.confirm(selectedId);
      await refresh();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirmed = status?.confirmed ?? null;
  const proposal = status?.proposal ?? null;
  /* The select offers only named Profiles; the confirmed summary below still
     resolves its name against the full list, so an older confirmation of a
     Profile that has since lost its name still shows what it was. */
  const ownerCandidates = profiles.filter(isNamedProfile);
  const proposedProfile =
    ownerCandidates.find((profile) => profile.id === proposal?.matchedProfileId) ?? null;

  return (
    <div className="card" role="group" aria-labelledby="group-owner-onboarding">
      <h3 id="group-owner-onboarding">Owner Profile</h3>
      {error ? <p role="alert">{error}</p> : null}
      {confirmed ? (
        <>
          <p className="connection-summary" role="status">
            <span className="ok">Confirmed</span> — Profile{" "}
            <strong>
              {profiles.find((p) => p.id === confirmed.profileId)?.fullName ?? confirmed.profileId}
            </strong>{" "}
            (revision {confirmed.profileRevision}) for {confirmed.confirmedForGoogleEmail}
          </p>
          <p>
            Outward workflows address the workspace owner through this reference. Connecting a
            different Google account voids it and asks you to confirm again.
          </p>
        </>
      ) : proposal ? (
        <>
          <p>
            Connected as <strong>{proposal.googleEmail}</strong>. Confirm which Person Profile is
            the canonical owner identity — the proposal is a suggestion, never a confirmation.
          </p>
          {proposedProfile ? (
            <p>
              Proposed by the connected email: <strong>{proposedProfile.fullName}</strong>.
            </p>
          ) : ownerCandidates.length === 0 ? (
            <p>
              No Person Profiles yet. <Link to="/people/new">Create one under Person Profiles</Link>{" "}
              with your connected email, then confirm it here.
            </p>
          ) : (
            <p>
              No existing Profile carries this email.{" "}
              <Link to="/people/new">Create one under Person Profiles</Link>, or select the
              corrected Profile below.
            </p>
          )}
          <label>
            Owner Profile
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              disabled={ownerCandidates.length === 0}
            >
              {ownerCandidates.length === 0 ? (
                <option value="">No Person Profiles yet</option>
              ) : null}
              {ownerCandidates.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.fullName}
                  {profile.primaryEmail ? ` — ${profile.primaryEmail}` : ""}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => void confirm()} disabled={busy || !selectedId}>
            {busy ? "Confirming…" : "Confirm owner Profile"}
          </button>
        </>
      ) : (
        <p>Connect a Google account to propose the owner Profile.</p>
      )}
    </div>
  );
}
