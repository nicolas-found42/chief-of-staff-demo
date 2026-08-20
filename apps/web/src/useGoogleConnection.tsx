import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { GoogleStatus } from "@chief-of-staff-demo/shared";
import { api } from "./client";

/**
 * The Google connection, held once for the whole Shell.
 *
 * Three consumers need the same value — the Shell banner, Home's identity line,
 * and the Settings card, which *mutates* it. Independent copies are the "two
 * vocabularies" failure ADR-0008 exists to have fixed, so Settings refreshes
 * through here rather than keeping a status of its own.
 *
 * Read ADR-0011 before changing when this refreshes: polling
 * `/api/google/status` looks like the scheduled proving ADR-0008 forbids and is
 * not, because that endpoint never calls Google.
 */
interface GoogleConnectionValue {
  /** null until the first request answers — nothing renders before then. */
  status: GoogleStatus | null;
  refresh: () => Promise<void>;
}

const GoogleConnectionContext = createContext<GoogleConnectionValue | null>(null);

export function GoogleConnectionProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.googleStatus());
    } catch {
      // The last known answer stands: a request that failed is not evidence the
      // connection changed, and blanking it would drop a standing warning.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ status, refresh }), [status, refresh]);

  return (
    <GoogleConnectionContext.Provider value={value}>{children}</GoogleConnectionContext.Provider>
  );
}

export function useGoogleConnection(): GoogleConnectionValue {
  const value = useContext(GoogleConnectionContext);
  if (!value) {
    throw new Error("useGoogleConnection must be used inside GoogleConnectionProvider");
  }
  return value;
}
