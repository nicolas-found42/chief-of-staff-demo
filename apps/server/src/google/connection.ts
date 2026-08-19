import { google } from "googleapis";
import type { AppConfig, GoogleStatus } from "@chief-of-staff-demo/shared";
import { GOOGLE_SCOPES, buildGoogleAuth, redirectUriForPort } from "./oauth.js";

/**
 * Google's documented answer for a refresh token it will not honour again:
 * revoked by the user, expired because the consent screen is still in Testing,
 * or invalidated by a password change (which any Gmail scope triggers). It is
 * the one failure that means "sign in again" — a DNS failure, an offline
 * machine, or a 5xx says nothing about the token, so those must not be reported
 * as a lost connection.
 */
export function isRejectedGrant(error: unknown): boolean {
  const reported = (error as { response?: { data?: { error?: string } } } | null | undefined)
    ?.response?.data?.error;
  if (typeof reported === "string") {
    return reported === "invalid_grant";
  }
  return /invalid_grant/.test(error instanceof Error ? error.message : String(error));
}

/**
 * The state of the Google connection, and who is signed in. The only thing that
 * proves a stored refresh token still works is spending it, so this asks Google
 * for an access token rather than inferring a connection from the presence of
 * three non-empty strings.
 */
export async function googleStatus(config: AppConfig, port: number): Promise<GoogleStatus> {
  const base = { redirectUri: redirectUriForPort(port), scopes: [...GOOGLE_SCOPES] };

  if (!config.google.clientId || !config.google.clientSecret) {
    return { state: "unconfigured", email: null, ...base };
  }
  if (!config.google.refreshToken) {
    return { state: "disconnected", email: null, ...base };
  }

  const auth = buildGoogleAuth(config, port);
  try {
    await auth.getAccessToken();
  } catch (error) {
    if (isRejectedGrant(error)) {
      return { state: "expired", email: null, ...base };
    }
    /* Google was unreachable, which is not evidence against the token. The
       credentials we hold are still the best answer we have. */
    return { state: "connected", email: null, ...base };
  }

  return { state: "connected", email: await profileEmail(auth), ...base };
}

/**
 * The signed-in address, for display only. Best effort: the token has already
 * proven itself by this point, so a Gmail call that fails here costs a name in
 * the UI and nothing else.
 */
async function profileEmail(auth: ReturnType<typeof buildGoogleAuth>): Promise<string | null> {
  try {
    const gmail = google.gmail({ version: "v1", auth });
    const profile = await gmail.users.getProfile({ userId: "me" });
    return profile.data.emailAddress ?? null;
  } catch {
    return null;
  }
}
