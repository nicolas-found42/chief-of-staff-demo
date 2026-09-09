import { useEffect, useState } from "react";
import type { MeetingBriefPersonProfileReadModel } from "@chief-of-staff-demo/shared";
import { Link, useNavigate } from "react-router-dom";
import { errorMessage } from "../../client";
import { meetingsApi, type MeetingsClient } from "../../clients/meetings";

export function BriefProfileRefresh({
  runId,
  client = meetingsApi,
}: {
  runId: string;
  client?: MeetingsClient;
}) {
  const navigate = useNavigate();
  const [profileReadModel, setProfileReadModel] =
    useState<MeetingBriefPersonProfileReadModel | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerationError, setRegenerationError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void client
      .meetingBriefProfileConsumers(runId)
      .then((readModel) => {
        if (current) setProfileReadModel(readModel);
      })
      .catch(() => {
        if (current) setProfileReadModel(null);
      });
    return () => {
      current = false;
    };
  }, [client, runId]);
  const staleProfileConsumers = (profileReadModel?.consumers ?? []).filter(
    (consumer) => consumer.state?.refreshRequired,
  );
  const regenerate = async () => {
    if (regenerating) return;
    setRegenerating(true);
    setRegenerationError(null);
    try {
      const refreshed = await client.regenerateMeetingBrief(runId);
      await navigate(`/runs/${refreshed.runId}`);
    } catch (error) {
      setRegenerationError(errorMessage(error));
      setRegenerating(false);
    }
  };

  return (
    <>
      {staleProfileConsumers.length > 0 ? (
        <div className="banner banner-warn" role="alert">
          <strong>Profile-derived claims need refresh.</strong> This immutable Brief used Profile
          evidence that was later corrected, merged, or detached. It cannot be retried in place;
          regenerate it from current Profile truth.
          <ul>
            {staleProfileConsumers.map(({ link, state }) => (
              <li key={`${link.guestEmail}-${link.profileId}-${link.profileRevision}`}>
                {link.guestEmail}: revision {link.profileRevision} of{" "}
                <Link to={`/people/${state?.currentProfileId ?? link.profileId}`}>
                  {state?.currentProfileId ?? link.profileId}
                </Link>
              </li>
            ))}
          </ul>
          <button type="button" className="primary" onClick={() => void regenerate()}>
            {regenerating ? "Regenerating…" : "Regenerate with current profiles"}
          </button>
          {regenerationError ? <p>{regenerationError}</p> : null}
        </div>
      ) : null}
    </>
  );
}
