import { useCallback, useEffect, useRef, useState } from "react";
import type { MeetingBriefIndex } from "@chief-of-staff-demo/shared";
import { errorMessage } from "./client";
import { meetingsApi } from "./clients/meetings";

/**
 * The read projection both Meeting Wizard surfaces render: one refresh /
 * Prepare-now / poll loop over the Cross-Run index (ADR-0005). The polling
 * predicate is the two pages' shared contract — any pending delivery or any
 * upcoming preparation keeps the projection live.
 *
 * Pass a stable fetcher (module-level or useCallback) so the initial refresh
 * effect does not re-run every render.
 */
export function useMeetingIndex(
  fetch: () => Promise<MeetingBriefIndex>,
  prepare: (occurrenceKey: string) => Promise<unknown> = meetingsApi.prepareMeetingBriefNow,
) {
  const [index, setIndex] = useState<MeetingBriefIndex | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const readGeneration = useRef(0);
  const readingRef = useRef(false);
  const preparingRef = useRef(false);
  const lifecycle = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current;
    readingRef.current = true;
    setReading(true);
    try {
      const next = await fetch();
      if (generation !== readGeneration.current) return;
      setIndex(next);
      setReadError(null);
    } catch (err) {
      if (generation === readGeneration.current) setReadError(errorMessage(err));
    } finally {
      if (generation === readGeneration.current) {
        readingRef.current = false;
        setReading(false);
      }
    }
  }, [fetch]);

  /** The Module's manual Run: prepare an occurrence now, then re-project. */
  const prepareNow = useCallback(
    async (occurrenceKey: string) => {
      // A ref closes the interval before React renders disabled controls.
      if (preparingRef.current) return;
      const generation = lifecycle.current;
      preparingRef.current = true;
      setPreparing(true);
      setPrepareError(null);
      try {
        await prepare(occurrenceKey);
        if (generation === lifecycle.current) await refresh();
      } catch (err) {
        if (generation === lifecycle.current) setPrepareError(errorMessage(err));
      } finally {
        if (generation === lifecycle.current) {
          preparingRef.current = false;
          setPreparing(false);
        }
      }
    },
    [refresh, prepare],
  );

  const invalidatePending = useCallback(() => {
    ++readGeneration.current;
    ++lifecycle.current;
  }, []);

  useEffect(() => {
    preparingRef.current = false;
    setPreparing(false);
    void refresh();
    return invalidatePending;
  }, [refresh, invalidatePending]);

  useEffect(() => {
    if (!index) return;
    const hasPending = index.briefs.some((b) => b.delivery?.status === "pending");
    if (!hasPending && index.upcoming.length === 0) return;
    const id = window.setInterval(() => {
      // Slow connections must not accumulate overlapping background requests.
      if (!readingRef.current && !preparingRef.current) void refresh();
    }, 5000);
    return () => window.clearInterval(id);
  }, [index, refresh]);

  return {
    index,
    // A successful read cannot establish that a failed preparation succeeded.
    error: prepareError ?? readError,
    busy: reading || preparing,
    refresh,
    prepareNow,
  };
}
