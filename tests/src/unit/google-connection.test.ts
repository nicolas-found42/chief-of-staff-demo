import { describe, expect, it } from "vitest";
import { GOOGLE_SCOPES } from "../../../apps/server/src/google/oauth";
import { googleStatus, isRejectedGrant } from "../../../apps/server/src/google/connection";
import { defaultConfig } from "../../../apps/server/src/config";

const PORT = 4317;

/** A config with client credentials present, and whatever token state is asked for. */
function configured(refreshToken: string | null) {
  const base = defaultConfig();
  return { ...base, google: { clientId: "id.apps", clientSecret: "secret", refreshToken } };
}

describe("googleStatus — states that need no network", () => {
  it("reports unconfigured until both client credentials are stored", async () => {
    await expect(googleStatus(defaultConfig(), PORT)).resolves.toMatchObject({
      state: "unconfigured",
      email: null,
    });

    const half = defaultConfig();
    half.google.clientId = "id.apps";
    await expect(googleStatus(half, PORT)).resolves.toMatchObject({ state: "unconfigured" });
  });

  it("reports disconnected once credentials are stored but nobody has signed in", async () => {
    await expect(googleStatus(configured(null), PORT)).resolves.toMatchObject({
      state: "disconnected",
      email: null,
    });
  });

  it("serves the redirect URI for the running port, and the scopes to register", async () => {
    // The UI used to hardcode both. Registering a URI that differs from the one
    // the server will send by even a character fails the exchange, so the value
    // has to come from the port in use.
    const status = await googleStatus(defaultConfig(), 5000);
    expect(status.redirectUri).toBe("http://localhost:5000/api/google/callback");
    expect(status.scopes).toEqual([...GOOGLE_SCOPES]);
  });
});

describe("isRejectedGrant", () => {
  it("treats Google's invalid_grant as a token that will not work again", () => {
    // The shape gaxios actually throws.
    expect(
      isRejectedGrant({
        response: { data: { error: "invalid_grant", error_description: "Token has been expired or revoked." } },
      })
    ).toBe(true);
    expect(isRejectedGrant(new Error("invalid_grant: Token has been expired or revoked."))).toBe(
      true
    );
  });

  it("does not blame the token for a failure that says nothing about it", () => {
    // This is the distinction the connection state rests on: an unreachable
    // Google must not present as a lost connection, or a flight-mode Settings
    // visit would tell the user to re-run the whole OAuth setup.
    expect(isRejectedGrant(new Error("getaddrinfo ENOTFOUND oauth2.googleapis.com"))).toBe(false);
    expect(isRejectedGrant({ response: { data: { error: "internal_failure" } } })).toBe(false);
    expect(isRejectedGrant({ code: "ECONNRESET" })).toBe(false);
    expect(isRejectedGrant(undefined)).toBe(false);
  });
});
