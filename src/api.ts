import { requestUrl } from "obsidian";
import { refreshTokens, type Tokens } from "./oauth";

// Thin transport to mininote's single-op RPC (POST /rpc/<Service>/<method> with {args}, Bearer auth)
// plus the token lifecycle. Results come back wrapped as {data:...}; errors as {error:{message,code}}.

export interface TokenStore {
  base: string;
  clientId: string;
  tokens: Tokens | null;
  save: (t: Tokens | null) => Promise<void>;
}

export class ReauthNeeded extends Error {}

export class Api {
  constructor(private store: TokenStore) {}

  private async accessToken(): Promise<string> {
    const t = this.store.tokens;
    if (!t) throw new ReauthNeeded("not connected to mininote");
    if (Date.now() < t.expires_at) return t.access_token;
    // expired -> rotate via refresh
    if (!t.refresh_token) throw new ReauthNeeded("session expired");
    try {
      const next = await refreshTokens(this.store.base, this.store.clientId, t.refresh_token);
      await this.store.save(next);
      return next.access_token;
    } catch (e) {
      // invalid_grant here means the app's scopes changed server-side (re-consent required) or the
      // refresh was revoked. Either way the only recovery is a fresh authorize.
      await this.store.save(null);
      throw new ReauthNeeded((e as Error)?.message || "please reconnect to mininote");
    }
  }

  async rpc<T = unknown>(service: string, method: string, args: unknown): Promise<T> {
    const token = await this.accessToken();
    const res = await requestUrl({
      url: this.store.base.replace(/\/$/, "") + `/rpc/${service}/${method}`,
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ args }),
      throw: false,
    });
    if (res.status === 401) {
      await this.store.save(null);
      throw new ReauthNeeded("mininote rejected the session — reconnect");
    }
    const parsed = res.json as { data?: T; error?: { message?: string; code?: string } };
    if (res.status >= 400 || parsed?.error) {
      throw new Error(parsed?.error?.message || `${service}/${method} failed (${res.status})`);
    }
    return (parsed?.data ?? {}) as T;
  }
}
