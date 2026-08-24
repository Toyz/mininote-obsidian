import { requestUrl } from "obsidian";

// PKCE (RFC 7636 / RFC 8252 native-app flow). mininote is the OAuth 2.0 authorization server; this
// plugin is a public client (no secret) that redirects to a custom obsidian:// scheme. PKCE is what
// stops another app that claims the same scheme from completing the exchange without the verifier.

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  expires_at: number; // epoch ms
  scope?: string;
}

const b64url = (buf: ArrayBuffer): string => {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export const randomUrlToken = (bytes = 32): string => {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf.buffer);
};

export const challengeFor = async (verifier: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(digest);
};

// authorizeUrl builds the browser URL the user opens to log in + consent. Scope is NOT sent — the
// mininote client row fixes it; the request's scope param is ignored server-side by design.
export const authorizeUrl = (base: string, clientId: string, redirectUri: string, challenge: string, state: string): string => {
  const u = new URL(base.replace(/\/$/, "") + "/oauth/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("code_challenge", challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  return u.toString();
};

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

const tokenPost = async (base: string, form: Record<string, string>): Promise<Tokens> => {
  const res = await requestUrl({
    url: base.replace(/\/$/, "") + "/oauth/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    throw: false,
  });
  const body = res.json as TokenResponse;
  if (res.status !== 200 || !body?.access_token) {
    throw new Error(body?.error_description || body?.error || `token endpoint ${res.status}`);
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    expires_at: Date.now() + Math.max(0, (body.expires_in ?? 0) - 30) * 1000, // 30s safety margin
    scope: body.scope,
  };
};

export const exchangeCode = (base: string, clientId: string, redirectUri: string, code: string, verifier: string): Promise<Tokens> =>
  tokenPost(base, { grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier });

export const refreshTokens = (base: string, clientId: string, refreshToken: string): Promise<Tokens> =>
  tokenPost(base, { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
