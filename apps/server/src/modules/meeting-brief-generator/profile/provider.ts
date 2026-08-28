/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion, @typescript-eslint/no-unnecessary-condition -- provider handles optional guest-profile fields and test fakes */
import {
  GUEST_PROFILE_PROVIDER_ID,
  GUEST_PROFILE_PROVIDER_NAME,
  type GuestProfileArtifact,
  type GuestProfileConfidence,
} from "@chief-of-staff-demo/shared";

export interface GuestProfileProvider {
  readonly id: typeof GUEST_PROFILE_PROVIDER_ID;
  /** Bounded lookup for one guest — fixed contract, no provider switching. */
  lookup(input: {
    guestEmail: string;
    endpoint: string;
    apiKey: string;
    occurrenceKey: string;
    eventVersion: string;
    signal?: AbortSignal;
  }): Promise<GuestProfileArtifact>;
}

export interface HttpFetch {
  (url: string, init: RequestInit): Promise<Response>;
}

function confidenceFrom(value: unknown): GuestProfileConfidence | null {
  if (value === "high" || value === "medium" || value === "low") return value;
  return null;
}

function normalizeArtifact(input: {
  guestEmail: string;
  occurrenceKey: string;
  eventVersion: string;
  endpoint: string;
  attemptedAt: string;
  statusCode?: number;
  error?: string;
  durationMs?: number;
  raw: unknown;
}): GuestProfileArtifact {
  const base = {
    guestEmail: input.guestEmail,
    occurrenceKey: input.occurrenceKey,
    eventVersion: input.eventVersion,
    source: GUEST_PROFILE_PROVIDER_ID as typeof GUEST_PROFILE_PROVIDER_ID,
    diagnostics: {
      provider: GUEST_PROFILE_PROVIDER_NAME as typeof GUEST_PROFILE_PROVIDER_NAME,
      endpoint: input.endpoint,
      attemptedAt: input.attemptedAt,
      ...(input.statusCode !== undefined ? { statusCode: input.statusCode } : {}),
      ...(input.error ? { error: input.error } : {}),
      ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
    },
  };

  if (
    input.error ||
    input.statusCode === 401 ||
    input.statusCode === 403 ||
    input.statusCode === 503
  ) {
    return {
      ...base,
      outcome: "failed",
      identityConfidence: null,
      role: null,
      background: null,
      currentEmployer: null,
      references: [],
    };
  }

  if (!input.raw || typeof input.raw !== "object") {
    return {
      ...base,
      outcome: "failed",
      identityConfidence: null,
      role: null,
      background: null,
      currentEmployer: null,
      references: [],
      diagnostics: {
        ...base.diagnostics,
        error: input.error ?? "malformed response: not an object",
      },
    };
  }
  const raw = input.raw as Record<string, unknown>;

  // Empty sentinel: { empty: true } or { profiles: [] } or { results: [] }
  if (raw.empty === true) {
    return {
      ...base,
      outcome: "empty",
      identityConfidence: null,
      role: null,
      background: null,
      currentEmployer: null,
      references: [],
    };
  }
  const profilesCandidate = (
    Array.isArray(raw.profiles) ? raw.profiles : Array.isArray(raw.results) ? raw.results : null
  ) as unknown[] | null;
  if (profilesCandidate !== null) {
    if (profilesCandidate.length === 0) {
      return {
        ...base,
        outcome: "empty",
        identityConfidence: null,
        role: null,
        background: null,
        currentEmployer: null,
        references: [],
      };
    }
    // Ambiguous when >1 profile
    if (profilesCandidate.length > 1) {
      const refs = profilesCandidate
        .flatMap((p) => {
          if (
            p &&
            typeof p === "object" &&
            Array.isArray((p as Record<string, unknown>).references)
          ) {
            return (p as Record<string, unknown>).references as string[];
          }
          if (
            p &&
            typeof p === "object" &&
            typeof (p as Record<string, unknown>).url === "string"
          ) {
            return [(p as Record<string, unknown>).url as string];
          }
          return [];
        })
        .filter((v) => typeof v === "string") as string[];
      const first = profilesCandidate[0] as Record<string, unknown>;
      return {
        ...base,
        outcome: "completed",
        identityConfidence: confidenceFrom(first.confidence ?? first.identityConfidence) ?? "low",
        role: typeof first.role === "string" ? first.role : null,
        background: typeof first.background === "string" ? first.background : null,
        // Ambiguous employer: do not claim Employer Match — keep unresolved but keep evidence.
        currentEmployer: null,
        references: refs,
      };
    }
    // Single profile — map
    const first = profilesCandidate[0] as Record<string, unknown>;
    const employerRaw = first.currentEmployer ?? first.employer ?? null;
    let currentEmployer: GuestProfileArtifact["currentEmployer"] = null;
    if (employerRaw && typeof employerRaw === "object") {
      const er = employerRaw as Record<string, unknown>;
      if (typeof er.name === "string" && er.name.trim().length > 0) {
        currentEmployer = {
          name: er.name.trim(),
          domain: typeof er.domain === "string" ? er.domain : null,
          evidence: Array.isArray(er.evidence)
            ? (er.evidence.filter((v) => typeof v === "string") as string[])
            : typeof er.evidence === "string"
              ? [er.evidence]
              : [],
        };
      }
    } else if (typeof employerRaw === "string" && employerRaw.trim().length > 0) {
      currentEmployer = { name: employerRaw.trim(), domain: null, evidence: [] };
    }
    const refs = Array.isArray(first.references)
      ? (first.references.filter((v) => typeof v === "string") as string[])
      : typeof first.url === "string"
        ? [first.url]
        : Array.isArray(first.sources)
          ? (first.sources.filter((v) => typeof v === "string") as string[])
          : [];
    return {
      ...base,
      outcome: "completed",
      identityConfidence: confidenceFrom(first.confidence ?? first.identityConfidence) ?? null,
      role: typeof first.role === "string" ? first.role : null,
      background: typeof first.background === "string" ? first.background : null,
      currentEmployer,
      references: refs,
    };
  }

  // Single-object shapes: { profile: {...} } or direct fields
  const profileObj = (raw.profile ?? raw) as Record<string, unknown>;
  if (
    profileObj &&
    typeof profileObj === "object" &&
    ("role" in profileObj ||
      "confidence" in profileObj ||
      "identityConfidence" in profileObj ||
      "currentEmployer" in profileObj ||
      "employer" in profileObj)
  ) {
    // Validate required shape — if role/background missing but employer present, still completed
    const identityConfidence = confidenceFrom(
      profileObj.confidence ?? profileObj.identityConfidence,
    );
    const role = typeof profileObj.role === "string" ? profileObj.role : null;
    const background = typeof profileObj.background === "string" ? profileObj.background : null;
    const employerRaw = profileObj.currentEmployer ?? profileObj.employer ?? null;
    let currentEmployer: GuestProfileArtifact["currentEmployer"] = null;
    let ambiguous = false;
    if (Array.isArray(employerRaw)) {
      // Multiple employers => ambiguous
      ambiguous = employerRaw.length !== 1;
      if (
        employerRaw.length === 1 &&
        typeof employerRaw[0] === "object" &&
        employerRaw[0] !== null
      ) {
        const er = employerRaw[0] as Record<string, unknown>;
        if (typeof er.name === "string") {
          currentEmployer = {
            name: er.name.trim(),
            domain: typeof er.domain === "string" ? er.domain : null,
            evidence: Array.isArray(er.evidence)
              ? (er.evidence.filter((v) => typeof v === "string") as string[])
              : [],
          };
        }
      } else if (employerRaw.length === 1 && typeof employerRaw[0] === "string") {
        currentEmployer = { name: (employerRaw[0] as string).trim(), domain: null, evidence: [] };
      } else {
        currentEmployer = null;
      }
    } else if (employerRaw && typeof employerRaw === "object") {
      const er = employerRaw as Record<string, unknown>;
      if (typeof er.name === "string" && er.name.trim().length > 0) {
        currentEmployer = {
          name: er.name.trim(),
          domain: typeof er.domain === "string" ? er.domain : null,
          evidence: Array.isArray(er.evidence)
            ? (er.evidence.filter((v) => typeof v === "string") as string[])
            : typeof er.evidence === "string"
              ? [er.evidence]
              : [],
        };
      }
    } else if (typeof employerRaw === "string" && employerRaw.trim().length > 0) {
      currentEmployer = { name: employerRaw.trim(), domain: null, evidence: [] };
    }
    if (ambiguous) currentEmployer = null;

    // malformed if profile object is present but missing all expected fields and not empty
    const hasAnyField =
      role !== null ||
      background !== null ||
      currentEmployer !== null ||
      identityConfidence !== null;
    if (
      !hasAnyField &&
      !Array.isArray(profileObj.references) &&
      typeof profileObj.url !== "string"
    ) {
      // Check if raw is not the expected shape — treat as malformed unless explicitly empty
      // For fixture coverage, malformed is e.g. { bad: "shape" } or not object
      const isMalformed = !raw.empty && !raw.profiles && !raw.results && !raw.profile;
      if (isMalformed && profileObj === raw) {
        return {
          ...base,
          outcome: "failed",
          identityConfidence: null,
          role: null,
          background: null,
          currentEmployer: null,
          references: [],
          diagnostics: { ...base.diagnostics, error: "malformed response: unrecognized shape" },
        };
      }
    }

    const refs = Array.isArray(profileObj.references)
      ? (profileObj.references.filter((v) => typeof v === "string") as string[])
      : typeof profileObj.url === "string"
        ? [profileObj.url as string]
        : Array.isArray(profileObj.sources)
          ? (profileObj.sources.filter((v) => typeof v === "string") as string[])
          : Array.isArray(raw.references)
            ? (raw.references.filter((v) => typeof v === "string") as string[])
            : [];
    return {
      ...base,
      outcome: "completed",
      identityConfidence,
      role,
      background,
      currentEmployer: ambiguous ? null : currentEmployer,
      references: refs,
    };
  }

  // If body is {} empty object -> empty
  if (Object.keys(raw).length === 0) {
    return {
      ...base,
      outcome: "empty",
      identityConfidence: null,
      role: null,
      background: null,
      currentEmployer: null,
      references: [],
    };
  }

  return {
    ...base,
    outcome: "failed",
    identityConfidence: null,
    role: null,
    background: null,
    currentEmployer: null,
    references: [],
    diagnostics: {
      ...base.diagnostics,
      error: input.error ?? "malformed response: unrecognized shape",
    },
  };
}

export function createHttpGuestProfileProvider(fetchImpl: HttpFetch = fetch): GuestProfileProvider {
  return {
    id: GUEST_PROFILE_PROVIDER_ID,
    async lookup(input): Promise<GuestProfileArtifact> {
      const attemptedAt = new Date().toISOString();
      const start = Date.now();
      const url = `${input.endpoint.replace(/\/$/, "")}/profile?email=${encodeURIComponent(input.guestEmail)}`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);
        const signal = input.signal ?? controller.signal;
        const res = await fetchImpl(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${input.apiKey}`,
            Accept: "application/json",
          },
          signal,
        });
        clearTimeout(timeout);
        const durationMs = Date.now() - start;
        if (res.status === 401) {
          throw Object.assign(new Error("rejected: unauthorized (401)"), { status: 401 });
        }
        if (res.status === 403) {
          throw Object.assign(new Error("missing_authority: forbidden (403)"), { status: 403 });
        }
        if (res.status === 503 || res.status === 502 || res.status === 504) {
          throw Object.assign(new Error(`unavailable: provider unavailable (${res.status})`), {
            status: res.status,
          });
        }
        if (res.status === 404) {
          return normalizeArtifact({
            guestEmail: input.guestEmail,
            occurrenceKey: input.occurrenceKey,
            eventVersion: input.eventVersion,
            endpoint: input.endpoint,
            attemptedAt,
            statusCode: 404,
            durationMs,
            raw: { empty: true },
          });
        }
        let body: unknown;
        try {
          body = await res.json();
        } catch (e) {
          return normalizeArtifact({
            guestEmail: input.guestEmail,
            occurrenceKey: input.occurrenceKey,
            eventVersion: input.eventVersion,
            endpoint: input.endpoint,
            attemptedAt,
            statusCode: res.status,
            error: `malformed: invalid JSON (${e instanceof Error ? e.message : String(e)})`,
            durationMs,
            raw: null,
          });
        }
        if (!res.ok) {
          return normalizeArtifact({
            guestEmail: input.guestEmail,
            occurrenceKey: input.occurrenceKey,
            eventVersion: input.eventVersion,
            endpoint: input.endpoint,
            attemptedAt,
            statusCode: res.status,
            error: `failed: ${res.status}`,
            durationMs,
            raw: body,
          });
        }
        return normalizeArtifact({
          guestEmail: input.guestEmail,
          occurrenceKey: input.occurrenceKey,
          eventVersion: input.eventVersion,
          endpoint: input.endpoint,
          attemptedAt,
          statusCode: res.status,
          durationMs,
          raw: body,
        });
      } catch (e) {
        const maybe = e as { status?: number };
        if (
          maybe?.status === 401 ||
          maybe?.status === 403 ||
          maybe?.status === 502 ||
          maybe?.status === 503 ||
          maybe?.status === 504
        )
          throw e;
        const message = e instanceof Error ? e.message : String(e);
        if (/rejected|missing_authority|unavailable/i.test(message)) throw e;
        const isAbort = message.toLowerCase().includes("abort");
        throw Object.assign(
          new Error(isAbort ? "unavailable: timeout" : `unavailable: ${message}`),
          { status: 503 },
        );
      }
    },
  };
}

// Test seam — fake provider covering 6 fixture shapes for host tests.
export type FakeProfileFixture =
  "exact" | "ambiguous" | "empty" | "malformed" | "rejected" | "unavailable";

export function createFakeGuestProfileProvider(
  mapping:
    | Record<string, FakeProfileFixture | GuestProfileArtifact>
    | ((email: string) => FakeProfileFixture | GuestProfileArtifact),
  opts: { endpoint?: string } = {},
): GuestProfileProvider {
  const endpoint = opts.endpoint ?? "https://fake-guest-profile.example";
  return {
    id: GUEST_PROFILE_PROVIDER_ID,
    async lookup(input): Promise<GuestProfileArtifact> {
      const fixture: FakeProfileFixture | GuestProfileArtifact =
        typeof mapping === "function"
          ? mapping(input.guestEmail)
          : (mapping[input.guestEmail] ?? "empty");
      if (typeof fixture === "object" && fixture !== null && "outcome" in fixture) {
        return fixture as GuestProfileArtifact;
      }
      const attemptedAt = new Date().toISOString();
      const base = {
        guestEmail: input.guestEmail,
        occurrenceKey: input.occurrenceKey,
        eventVersion: input.eventVersion,
        source: GUEST_PROFILE_PROVIDER_ID as typeof GUEST_PROFILE_PROVIDER_ID,
      };
      switch (fixture as FakeProfileFixture) {
        case "exact":
          return {
            ...base,
            outcome: "completed",
            identityConfidence: "high",
            role: "CTO at Fixture Corp",
            background: "10 years building Fixture Corp",
            currentEmployer: {
              name: "Fixture Corp",
              domain: "fixture.example",
              evidence: ["Fixture Corp team page lists CTO"],
            },
            references: ["https://fixture.example/team"],
            diagnostics: {
              provider: GUEST_PROFILE_PROVIDER_NAME,
              endpoint,
              attemptedAt,
              statusCode: 200,
            },
          };
        case "ambiguous":
          return {
            ...base,
            outcome: "completed",
            identityConfidence: "low",
            role: "Advisor",
            background: "Multiple affiliations",
            currentEmployer: null,
            references: ["https://fixture.example/a", "https://other.example/b"],
            diagnostics: {
              provider: GUEST_PROFILE_PROVIDER_NAME,
              endpoint,
              attemptedAt,
              statusCode: 200,
              error: "ambiguous: multiple employers",
            },
          };
        case "empty":
          return {
            ...base,
            outcome: "empty",
            identityConfidence: null,
            role: null,
            background: null,
            currentEmployer: null,
            references: [],
            diagnostics: {
              provider: GUEST_PROFILE_PROVIDER_NAME,
              endpoint,
              attemptedAt,
              statusCode: 200,
            },
          };
        case "malformed":
          return {
            ...base,
            outcome: "failed",
            identityConfidence: null,
            role: null,
            background: null,
            currentEmployer: null,
            references: [],
            diagnostics: {
              provider: GUEST_PROFILE_PROVIDER_NAME,
              endpoint,
              attemptedAt,
              statusCode: 200,
              error: "malformed response: unrecognized shape",
            },
          };
        case "rejected":
          return {
            ...base,
            outcome: "failed",
            identityConfidence: null,
            role: null,
            background: null,
            currentEmployer: null,
            references: [],
            diagnostics: {
              provider: GUEST_PROFILE_PROVIDER_NAME,
              endpoint,
              attemptedAt,
              statusCode: 401,
              error: "rejected: unauthorized (401)",
            },
          };
        case "unavailable":
          return {
            ...base,
            outcome: "failed",
            identityConfidence: null,
            role: null,
            background: null,
            currentEmployer: null,
            references: [],
            diagnostics: {
              provider: GUEST_PROFILE_PROVIDER_NAME,
              endpoint,
              attemptedAt,
              statusCode: 503,
              error: "unavailable: provider unavailable (503)",
            },
          };
        default:
          return {
            ...base,
            outcome: "empty",
            identityConfidence: null,
            role: null,
            background: null,
            currentEmployer: null,
            references: [],
            diagnostics: {
              provider: GUEST_PROFILE_PROVIDER_NAME,
              endpoint,
              attemptedAt,
              statusCode: 200,
            },
          };
      }
    },
  };
}
