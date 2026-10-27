import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { can, ConnectionProvider, type ConnectedAccount, type WorkspaceMember } from "@muselaunch/contracts";
import { newId, type WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, type Platform } from "@muselaunch/platform";
import { HttpClient, providerAdapter, PROVIDER_ADAPTERS, type OAuthTokens, type ProviderAdapter } from "@muselaunch/providers";
import { z } from "zod";
import { growthDeps, redirectUriFor } from "./deps";

/**
 * OAuth connections. `state` is an HMAC-signed token bound to workspace + user + provider + nonce +
 * expiry. The PKCE verifier never leaves the server: it is stored encrypted (platform secrets)
 * under the nonce and deleted on first use, so a state can be redeemed once.
 */

export const STATE_TTL_MS = 10 * 60_000;
const StatePayload = z.object({ v: z.literal(1), w: z.string(), u: z.string(), p: ConnectionProvider, n: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/), e: z.number(), a: z.string().optional() });
export type OAuthState = z.infer<typeof StatePayload>;
const NonceRecord = z.object({ provider: ConnectionProvider, uid: z.string(), verifier: z.string().optional(), appId: z.string().optional(), exp: z.number() });

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

export function signState(key: Buffer, payload: OAuthState): string {
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/** Verify signature + expiry. Throws FORBIDDEN on any tampering. */
export function verifyState(key: Buffer, token: string, now = Date.now()): OAuthState {
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) throw new AppError("FORBIDDEN", "Malformed OAuth state");
  const expected = createHmac("sha256", key).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) throw new AppError("FORBIDDEN", "OAuth state signature invalid");
  let parsed: OAuthState;
  try {
    parsed = StatePayload.parse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
  } catch {
    throw new AppError("FORBIDDEN", "OAuth state payload invalid");
  }
  if (parsed.e < now) throw new AppError("FORBIDDEN", "OAuth state expired");
  return parsed;
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

const nonceSecretId = (nonce: string) => `oauthnonce_${nonce}`;
export const tokenSecretId = (accountId: string) => `tok_${accountId}`;

/** SecretStore.get throws on a deleted (emptied) record; treat that as absent. */
async function readSecret<T>(p: Platform, wid: string, id: string): Promise<T | null> {
  try {
    return await p.secrets.get<T>(wid, id);
  } catch {
    return null;
  }
}

export type ProviderAvailability = "not_configured" | "pending_review" | "available";

/** Honest per-provider availability for the Connections screen. */
export function providerCatalog(p: Platform) {
  const { settings } = growthDeps(p);
  return Object.values(PROVIDER_ADAPTERS).map((a) => {
    const configured = Boolean(settings.creds[a!.provider]);
    const state: ProviderAvailability = !configured ? "not_configured" : a!.review.required && !(a!.provider === "tiktok" && settings.adapter.tiktokAudited) ? "pending_review" : "available";
    return {
      provider: a!.provider,
      label: a!.label,
      channels: a!.channels,
      purposes: a!.purposes,
      capabilities: a!.capabilities,
      accepts: a!.accepts,
      configured,
      state,
      review: a!.review,
      env: [a!.env.clientId, a!.env.clientSecret],
      redirectUri: redirectUriFor(p, a!.provider),
      detail: !configured
        ? `Not configured on this deployment (set ${a!.env.clientId} / ${a!.env.clientSecret}). Use the export package + manual posting meanwhile.`
        : state === "pending_review"
          ? "Configured. Until the provider's review/verification is complete, only accounts registered with the developer app (testers/owned accounts) can connect, with the limits listed."
          : "Configured.",
    };
  });
}

function adapterOrThrow(provider: string): ProviderAdapter {
  const parsed = ConnectionProvider.safeParse(provider);
  const a = parsed.success ? providerAdapter(parsed.data) : undefined;
  if (!a) throw new AppError("NOT_FOUND", `No OAuth connection for ${provider}`, { userMessage: "This service can't be connected here." });
  return a;
}

function credsOrThrow(p: Platform, a: ProviderAdapter) {
  const c = growthDeps(p).settings.creds[a.provider];
  if (!c) throw new AppError("PROVIDER_NOT_CONFIGURED", `${a.label} OAuth client is not configured (${a.env.clientId})`, { userMessage: `${a.label} isn't connected on this deployment yet. Use the export package and post manually.` });
  return c;
}

/** Start an OAuth connection: returns the provider authorize URL. */
export async function startConnection(p: Platform, wid: string, uid: string, provider: string, opts: { appId?: string } = {}): Promise<{ authorizeUrl: string; expiresAt: string; provider: string }> {
  const a = adapterOrThrow(provider);
  const creds = credsOrThrow(p, a);
  const { settings, now } = growthDeps(p);
  const nonce = randomBytes(24).toString("base64url");
  const exp = now() + STATE_TTL_MS;
  const pkce = a.oauth.pkce ? pkcePair() : undefined;
  await p.secrets.put(wid, nonceSecretId(nonce), "oauth_nonce", { provider: a.provider, uid, verifier: pkce?.verifier, appId: opts.appId, exp });
  const state = signState(settings.oauthStateKey, { v: 1, w: wid, u: uid, p: a.provider, n: nonce, e: exp, a: opts.appId });
  const authorizeUrl = a.oauth.authorizeUrl({ clientId: creds.clientId, redirectUri: redirectUriFor(p, a.provider), state, codeChallenge: pkce?.challenge, settings: settings.adapter });
  return { authorizeUrl, expiresAt: new Date(exp).toISOString(), provider: a.provider };
}

// ---------------------------------------------------------------------------
// Callback → PENDING connection → authenticated finish (binds consent to the signed-in user)
// ---------------------------------------------------------------------------

/**
 * SECURITY (review N1): the public callback can be completed by ANY browser that opens an authorize
 * link, so it must not attach an account to a workspace by itself. It only exchanges the code and
 * parks the result as a PENDING connection (tokens encrypted in secrets) keyed by the single-use
 * nonce, plus a fresh completion secret that only the consenting browser receives. The signed-in
 * user then calls `POST /connections/finish`; the connection is activated only if that user is the
 * one who started the flow and still has `accounts.manage`. Anything else discards (and revokes) it.
 */
export const PENDING_TTL_MS = 10 * 60_000;
const PENDING_INDEX_KEY = "growth.oauthPending";
const PendingIndex = z.object({ items: z.array(z.object({ nonce: z.string(), exp: z.number(), provider: z.string() })).default([]) });
const pendingSecretId = (nonce: string) => `oauthpending_${nonce}`;

interface PendingRecord {
  provider: ConnectedAccount["provider"];
  uid: string;
  appId?: string;
  exp: number;
  completionHash: string;
  tokens: OAuthTokens;
  identity: { externalAccountId: string; displayName: string; limitations: string[] };
}

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

async function pendingIndexUpdate(p: Platform, wid: string, fn: (items: z.infer<typeof PendingIndex>["items"]) => z.infer<typeof PendingIndex>["items"]) {
  await p.db.runTransaction(async (tx) => {
    const cur = (await tx.getState(wid, PENDING_INDEX_KEY, PendingIndex)) ?? { items: [] };
    tx.setState(wid, PENDING_INDEX_KEY, PendingIndex, { items: fn(cur.items).slice(-200) });
  });
}

/** Revoke (best effort) and delete a pending connection. */
async function discardPending(p: Platform, wid: string, nonce: string, rec: PendingRecord | null, reason: string, actor: string): Promise<{ revoked: boolean }> {
  let revoked = false;
  const a = rec ? providerAdapter(rec.provider) : undefined;
  const creds = a ? growthDeps(p).settings.creds[a.provider] : undefined;
  if (rec && a?.oauth.revoke && creds) {
    try {
      await a.oauth.revoke(rec.tokens, creds, new HttpClient(growthDeps(p).fetch, a.label), growthDeps(p).settings.adapter);
      revoked = true;
    } catch (err) {
      p.log.warn({ workspaceId: wid, provider: rec.provider, code: toAppError(err).code }, "revoking discarded pending connection failed");
    }
  }
  await p.secrets.delete(wid, pendingSecretId(nonce));
  await pendingIndexUpdate(p, wid, (items) => items.filter((i) => i.nonce !== nonce));
  if (rec) await p.db.ws(wid).collection("auditLog").create({ action: "connection.discarded", data: { provider: rec.provider, startedBy: rec.uid, reason, revoked } }, { actor });
  return { revoked };
}

/** Delete (and revoke) pending connections older than PENDING_TTL_MS. Called by the scheduler tick and on access. */
export async function purgeExpiredPendingConnections(p: Platform, wid: string): Promise<number> {
  const idx = await p.db.ws(wid).state(PENDING_INDEX_KEY, PendingIndex).get();
  const now = growthDeps(p).now();
  const expired = (idx?.items ?? []).filter((i) => i.exp < now);
  for (const i of expired) await discardPending(p, wid, i.nonce, await readSecret<PendingRecord>(p, wid, pendingSecretId(i.nonce)), "expired", "system");
  return expired.length;
}

/**
 * OAuth callback (public route). Verifies the signed state and redeems the single-use nonce, then
 * exchanges the code and stores a PENDING connection. Never attaches an account by itself.
 */
export async function completeConnection(p: Platform, provider: string, q: { code?: string; state?: string; error?: string; error_description?: string }): Promise<{ ok: boolean; redirect: string; error?: string }> {
  const web = p.cfg.PUBLIC_WEB_URL.replace(/\/$/, "");
  const a = adapterOrThrow(provider);
  const { settings, now, fetch } = growthDeps(p);
  if (!q.state) throw new AppError("FORBIDDEN", "Missing OAuth state");
  const st = verifyState(settings.oauthStateKey, q.state, now());
  // Back to the app's calendar (connections panel) when started there, else workspace integrations.
  const back = (params: Record<string, string>) =>
    `${web}/w/${encodeURIComponent(st.w)}${st.a ? `/a/${encodeURIComponent(st.a)}/calendar` : "/settings/integrations"}?${new URLSearchParams({ connections: "1", ...params }).toString()}`;
  if (st.p !== a.provider) throw new AppError("FORBIDDEN", "OAuth state was issued for a different provider");
  const nonce = await readSecret<z.infer<typeof NonceRecord>>(p, st.w, nonceSecretId(st.n));
  const rec = nonce ? NonceRecord.safeParse(nonce) : null;
  if (!rec?.success || rec.data.uid !== st.u || rec.data.provider !== st.p || rec.data.exp < now()) throw new AppError("FORBIDDEN", "OAuth state already used or unknown");
  await p.secrets.delete(st.w, nonceSecretId(st.n));

  if (q.error) return { ok: false, redirect: back({ provider: a.provider, status: "cancelled", message: (q.error_description ?? q.error).slice(0, 200) }), error: q.error };
  if (!q.code) throw new AppError("BAD_REQUEST", "Missing authorization code");

  const ws = p.db.ws(st.w);
  const [workspace, member] = await Promise.all([p.db.top("workspaces").get(st.w), ws.collection("members").get(st.u)]);
  if (!workspace || !member || !can(member, "accounts.manage")) throw new AppError("FORBIDDEN", "The user who started this connection can no longer connect accounts in this workspace");

  const creds = credsOrThrow(p, a);
  const http = new HttpClient(fetch, a.label);
  try {
    const tokens = await a.oauth.exchangeCode({ code: q.code, redirectUri: redirectUriFor(p, a.provider), codeVerifier: rec.data.verifier, creds, settings: settings.adapter }, http);
    const id = await a.oauth.identity(tokens, http, settings.adapter, creds);
    const missing = a.oauth.scopes.filter((s) => !["openid", "email", "profile"].includes(s) && tokens.scope.length > 0 && !tokens.scope.includes(s));
    const limitations = [
      ...(id.limitations ?? []),
      ...(missing.length ? [`Not granted: ${missing.join(", ")}`] : []),
      ...(a.provider === "tiktok" && !settings.adapter.tiktokAudited ? ["TikTok app not yet audited: posts are published as private (Only me)."] : []),
    ].slice(0, 10);
    const completion = randomBytes(24).toString("base64url");
    const exp = now() + PENDING_TTL_MS;
    const pending: PendingRecord = {
      provider: a.provider,
      uid: st.u,
      appId: rec.data.appId,
      exp,
      completionHash: sha256hex(completion),
      tokens: { ...tokens, extra: { ...tokens.extra, ...id.extra } },
      identity: { externalAccountId: id.externalAccountId.slice(0, 200), displayName: id.displayName.slice(0, 200), limitations },
    };
    await p.secrets.put(st.w, pendingSecretId(st.n), "oauth_pending", pending);
    await pendingIndexUpdate(p, st.w, (items) => [...items.filter((i) => i.nonce !== st.n), { nonce: st.n, exp, provider: a.provider }]);
    return { ok: true, redirect: back({ provider: a.provider, status: "pending", finish: `${st.n}.${completion}` }) };
  } catch (raw) {
    const err = toAppError(raw);
    p.log.warn({ provider: a.provider, workspaceId: st.w, code: err.code, message: err.message }, "oauth callback failed");
    return { ok: false, redirect: back({ provider: a.provider, status: "error", message: (err.toInfo().userMessage ?? err.message).slice(0, 200) }), error: err.code };
  }
}

export const FinishConnectionRequest = z.object({ token: z.string().max(300) });

/**
 * Authenticated finish (`POST /connections/finish`). Activates the pending connection only for the
 * user bound in the OAuth state who still has `accounts.manage`, presenting the completion secret
 * the consenting browser received. Any other caller holding a valid token discards it (revoked).
 */
export async function finishConnection(p: Platform, wid: string, member: WorkspaceMember, token: string | undefined): Promise<{ account: ConnectedAccount }> {
  const m = token?.match(/^([A-Za-z0-9_-]{16,64})\.([A-Za-z0-9_-]{16,128})$/);
  const nonce = m?.[1];
  const rec = nonce ? await readSecret<PendingRecord>(p, wid, pendingSecretId(nonce)) : null;
  const expected = rec ? Buffer.from(rec.completionHash, "hex") : null;
  const got = m ? Buffer.from(sha256hex(m[2]!), "hex") : null;
  const proven = Boolean(expected && got && expected.length === got.length && timingSafeEqual(expected, got));
  const actor = member.userId;

  if (!can(member, "accounts.manage")) {
    if (proven) await discardPending(p, wid, nonce!, rec, "finished by a member without accounts.manage", actor);
    throw new AppError("FORBIDDEN", "Missing capability accounts.manage", { userMessage: "You don't have permission to connect accounts in this workspace. The connection was not added." });
  }
  if (!m) throw new AppError("BAD_REQUEST", "Invalid connection token");
  if (!rec) throw new AppError("CONFLICT", "This connection request expired or was already used", { userMessage: "This connection request expired. Connect the account again." });
  if (!proven) throw new AppError("FORBIDDEN", "Connection completion code is invalid");
  if (rec.exp < growthDeps(p).now()) {
    await discardPending(p, wid, nonce!, rec, "expired", actor);
    throw new AppError("CONFLICT", "This connection request expired", { userMessage: "This connection request expired. Connect the account again." });
  }
  if (rec.uid !== member.userId) {
    await discardPending(p, wid, nonce!, rec, "finished by a different user than the one who started it", actor);
    throw new AppError("FORBIDDEN", "Connection was started by a different user", { userMessage: "This connection was started by someone else, so it was discarded and access was revoked. Start the connection yourself to add an account." });
  }

  const a = adapterOrThrow(rec.provider);
  const ws = p.db.ws(wid);
  const existing = (await ws.collection("connectedAccounts").list({ limit: 200 })).items.find((x) => x.provider === a.provider && x.externalAccountId === rec.identity.externalAccountId);
  const accountId = existing?.id ?? newId("acc");
  await p.secrets.put(wid, tokenSecretId(accountId), `oauth_${a.provider}`, rec.tokens);
  const fields = {
    appId: rec.appId,
    provider: a.provider,
    purposes: a.purposes,
    externalAccountId: rec.identity.externalAccountId,
    displayName: rec.identity.displayName,
    scopes: rec.tokens.scope.slice(0, 50),
    status: "connected" as const,
    capabilities: a.capabilities,
    secretId: tokenSecretId(accountId),
    limitations: rec.identity.limitations,
    lastError: undefined,
  };
  const account = existing
    ? await ws.collection("connectedAccounts").update(existing.id, fields, { actor })
    : await ws.collection("connectedAccounts").create({ id: accountId, ...fields, connectedBy: actor }, { actor });
  await p.secrets.delete(wid, pendingSecretId(nonce!));
  await pendingIndexUpdate(p, wid, (items) => items.filter((i) => i.nonce !== nonce));
  await ws.collection("auditLog").create({ action: "connection.connected", target: { entity: "connectedAccounts", id: account.id }, data: { provider: a.provider, externalAccountId: account.externalAccountId } }, { actor });
  return { account };
}

/** Revoke at the provider (best effort), delete the encrypted tokens, mark the account revoked. */
export async function disconnectAccount(p: Platform, wid: string, accountId: string, actor: string): Promise<{ account: ConnectedAccount; revokedRemotely: boolean; note?: string }> {
  const ws = p.db.ws(wid);
  const acc = await ws.collection("connectedAccounts").getOrThrow(accountId);
  const a = providerAdapter(acc.provider);
  let revokedRemotely = false;
  let note: string | undefined;
  const tokens = acc.secretId ? await readSecret<OAuthTokens>(p, wid, acc.secretId) : null;
  const creds = a ? growthDeps(p).settings.creds[a.provider] : undefined;
  if (a?.oauth.revoke && tokens && creds) {
    try {
      await a.oauth.revoke(tokens, creds, new HttpClient(growthDeps(p).fetch, a.label), growthDeps(p).settings.adapter);
      revokedRemotely = true;
    } catch (err) {
      note = `Could not revoke at ${a.label} (${toAppError(err).message}); remove MuseLaunch from the account's connected apps manually.`;
    }
  } else if (a && !a.oauth.revoke) {
    note = `${a.label} has no revoke API: remove MuseLaunch under the account's "Apps and websites" settings to fully revoke access.`;
  }
  if (acc.secretId) await p.secrets.delete(wid, acc.secretId);
  const account = await ws.collection("connectedAccounts").update(acc.id, { status: "revoked", secretId: undefined, lastError: note }, { actor });
  await ws.collection("auditLog").create({ action: "connection.disconnected", target: { entity: "connectedAccounts", id: acc.id }, data: { provider: acc.provider, revokedRemotely } }, { actor });
  return { account, revokedRemotely, note };
}

/** Load tokens for an account, refreshing them when they expire within 2 minutes. */
export async function freshTokens(p: Platform, ws: WorkspaceDb, account: ConnectedAccount, actor: string): Promise<OAuthTokens> {
  const a = providerAdapter(account.provider);
  if (!a) throw new AppError("PROVIDER_NOT_CONFIGURED", `No adapter for ${account.provider}`);
  if (account.status !== "connected" || !account.secretId) throw new AppError("PROVIDER_ERROR", `${a.label} connection is ${account.status}`, { userMessage: `Reconnect ${a.label} to publish.`, details: { reconnect: true } });
  const tokens = await readSecret<OAuthTokens>(p, ws.workspaceId, account.secretId);
  if (!tokens?.accessToken) throw new AppError("PROVIDER_ERROR", `${a.label} tokens missing`, { details: { reconnect: true }, userMessage: `Reconnect ${a.label} to publish.` });
  const { now, settings, fetch } = growthDeps(p);
  if (!tokens.expiresAt || tokens.expiresAt - now() > 120_000) return tokens;
  const creds = settings.creds[a.provider];
  if (!a.oauth.refresh || !creds) {
    await ws.collection("connectedAccounts").update(account.id, { status: "expired", lastError: "Access token expired" }, { actor });
    throw new AppError("PROVIDER_ERROR", `${a.label} access token expired`, { details: { reconnect: true }, userMessage: `Your ${a.label} connection expired. Reconnect it to publish.` });
  }
  try {
    const next = await a.oauth.refresh(tokens, creds, new HttpClient(fetch, a.label), settings.adapter);
    const merged: OAuthTokens = { ...next, extra: { ...tokens.extra, ...next.extra } };
    await p.secrets.put(ws.workspaceId, account.secretId, `oauth_${a.provider}`, merged);
    return merged;
  } catch (raw) {
    const err = toAppError(raw);
    if (!err.retryable) await ws.collection("connectedAccounts").update(account.id, { status: "expired", lastError: err.message.slice(0, 1000) }, { actor });
    throw err;
  }
}

/** Connected (usable) account for a provider, if any. */
export async function connectedAccountFor(ws: WorkspaceDb, provider: ConnectedAccount["provider"], accountId?: string): Promise<ConnectedAccount | null> {
  if (accountId) {
    const a = await ws.collection("connectedAccounts").get(accountId);
    return a && a.provider === provider ? a : null;
  }
  const all = (await ws.collection("connectedAccounts").list({ limit: 200 })).items;
  return all.find((a) => a.provider === provider && a.status === "connected") ?? null;
}

