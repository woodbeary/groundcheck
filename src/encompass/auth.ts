/**
 * Authenticating as the lender's own integration. ICE: "Grant type client_credentials is for ISV
 * partners only. Lenders must use grant type = password" (docs/authentication, checked
 * 2026-11-01). The API key's client id and secret go as HTTP Basic, the user is an API user on a
 * dedicated persona with only eFolder access, the CX.ED fields and Subscribe to Webhooks (not a
 * copy of Administrator), and the username is `{user}@encompass:{instance}`. A super administrator
 * retrieves the key, separately for each instance; test instances usually start with TEBE.
 */

export interface LenderCredentials {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly user: string;
  readonly password: string;
  readonly instance: string;
}

export const TOKEN_URL = "https://api.elliemae.com/oauth2/v1/token";

export function tokenRequest(c: LenderCredentials, grant: "password" | "client_credentials" = "password") {
  if (grant !== "password") throw new Error("client_credentials is for ISV partners only; a lender's integration uses the password grant through its API user");
  if (!c.instance) throw new Error("the instance id is part of the username");
  return {
    url: TOKEN_URL,
    method: "POST" as const,
    headers: { Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", username: `${c.user}@encompass:${c.instance}`, password: c.password }).toString(),
  };
}

export const isTestInstance = (instance: string) => /^TEBE/i.test(instance);

/** Ocrolus tokens last 24 hours; its docs suggest refreshing every 12. */
export const refreshOcrolusToken = (issuedAtSeconds: number, nowSeconds: number) => nowSeconds - issuedAtSeconds >= 12 * 3600;
