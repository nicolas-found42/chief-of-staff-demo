import { google } from "googleapis";
import type { OAuth2Client } from "googleapis-common";
import type { AppConfig } from "@chief-of-staff-demo/shared";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/tasks",
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/drive.readonly",
];

/** The exact redirect URI that must be registered in Google Cloud Console. */
export function redirectUriForPort(port: number): string {
  return `http://localhost:${port}/api/google/callback`;
}
/** Authorized Google API client used by every google/* module. */
export type GoogleAuth = OAuth2Client;
export function buildGoogleAuth(config: AppConfig, port: number): GoogleAuth {
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUriForPort(port)
  );
  if (config.google.refreshToken) {
    client.setCredentials({ refresh_token: config.google.refreshToken });
  }
  return client;
}

export function googleAuthUrl(config: AppConfig, port: number): string {
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUriForPort(port)
  );
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [...GOOGLE_SCOPES],
  });
}

export async function exchangeGoogleCode(
  config: AppConfig,
  port: number,
  code: string
): Promise<{ refreshToken: string; grantedScopes: string[] }> {
  const client = new google.auth.OAuth2(
    config.google.clientId,
    config.google.clientSecret,
    redirectUriForPort(port)
  );
  const { tokens } = await client.getToken(code);
  const refresh = tokens.refresh_token;
  if (!refresh) {
    throw new Error("Google did not return a refresh token");
  }
  const scopeString = (tokens as { scope?: string }).scope ?? (tokens as { scopes?: string[] }).scopes?.join(" ") ?? "";
  const grantedScopes = scopeString
    .split(" ")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return { refreshToken: refresh, grantedScopes };
}

export async function mintAccessToken(
  config: AppConfig,
  port: number
): Promise<{ token: string; expiresAt: string | null }> {
  const auth = buildGoogleAuth(config, port);
  const result = await auth.getAccessToken();
  const token = (result as { token?: string | null }).token ?? auth.credentials.access_token ?? null;
  if (!token) {
    throw new Error("Google did not return an access token");
  }
  const expiry = auth.credentials.expiry_date ?? null;
  const expiresAt = expiry ? new Date(expiry).toISOString() : null;
  return { token, expiresAt };
}
