import { createHash } from "node:crypto";
import { WEB_PUSH_ENDPOINT_MAX, WEB_PUSH_MAX_PER_USER, type WebPushBrowserView, type WebPushPayload, type WebPushSubscription, type WebPushSubscriptionInput } from "@muselaunch/contracts";
import type { Db } from "@muselaunch/db";
import { Agent, fetch as undiciFetch } from "undici";
import webpush from "web-push";
import type { Config } from "./config";
import { AppError } from "./errors";
import type { Platform } from "./platform";
import { assertSafeUrl, resolveSafe } from "./safe-fetch";

/**
 * Notifications in the browser (Web Push, RFC 8030 + VAPID), so a note reaches the person's computer
 * or Android browser with every MuseLaunch tab closed.
 *
 * Keys: WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY (setup-web-push.cmd writes them to
 * .env; deploy passes the private key as a Secret Manager secret). Without them a local server
 * (APP_ENV=local) makes a temporary pair at startup and says so once; production simply has browser
 * notifications off, and `GET /v1/push/web/config` says `enabled: false`.
 *
 * Subscriptions are `webPushSubscriptions/{sha256(endpoint)}`. The `web-push` library encrypts the
 * payload and signs the VAPID token; the request itself goes out through `sender` (pinned to the
 * address checked by resolveSafe, so an endpoint can't be pointed at an internal host later), which
 * tests replace with `setWebPushSender`. A 404/410 from the push service removes the subscription;
 * a few refusals in a row too. Endpoints and keys are never logged, only the push service's host.
 */

const TIMEOUT_MS = 8_000;
/** Refusals in a row (400/403/413…) before a subscription is dropped. 404/410 drop it at once. */
const MAX_FAILURES = 5;
const CONCURRENCY = 8;

export interface WebPushKeys {
  publicKey: string;
  privateKey: string;
  subject: string;
  /** First 16 hex of sha256(publicKey): which key a subscription was made with. */
  keyId: string;
  /** Made at startup because none were configured (local only). */
  ephemeral: boolean;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const webPushSubscriptionId = (endpoint: string) => sha256(endpoint);
export const webPushKeyId = (publicKey: string) => sha256(publicKey).slice(0, 16);

const isEmail = (s: string | undefined): s is string => Boolean(s && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s));

/** Who push services can contact: WEB_PUSH_SUBJECT, else mailto: the contact or operator email, else the web URL (https). */
export function webPushSubject(cfg: Pick<Config, "WEB_PUSH_SUBJECT" | "NEXT_PUBLIC_CONTACT_EMAIL" | "OPERATOR_EMAIL" | "PUBLIC_WEB_URL">): string {
  const explicit = cfg.WEB_PUSH_SUBJECT?.trim();
  if (explicit && (/^mailto:[^\s@]+@[^\s@]+$/i.test(explicit) || /^https:\/\/[^\s/]+/i.test(explicit))) return explicit;
  const email = [cfg.NEXT_PUBLIC_CONTACT_EMAIL?.trim(), cfg.OPERATOR_EMAIL?.trim()].find(isEmail);
  if (email) return `mailto:${email}`;
  try {
    const u = new URL(cfg.PUBLIC_WEB_URL);
    if (u.protocol === "https:" && u.hostname !== "localhost") return u.origin;
  } catch {
    /* not a URL */
  }
  // Local runs without an email: a valid address that reaches no one (push services only need the shape).
  return "mailto:notifications@muselaunch.invalid";
}

/** A VAPID key pair (P-256): the public key uncompressed (65 bytes), the private key 32 bytes, both base64url. */
export function generateWebPushKeys(): { publicKey: string; privateKey: string } {
  return webpush.generateVAPIDKeys();
}

function validPair(publicKey: string, privateKey: string): boolean {
  const b64 = /^[A-Za-z0-9_-]+$/;
  if (!b64.test(publicKey) || !b64.test(privateKey)) return false;
  const pub = Buffer.from(publicKey, "base64url");
  const priv = Buffer.from(privateKey, "base64url");
  return pub.length === 65 && pub[0] === 4 && priv.length === 32;
}

let ephemeral: { publicKey: string; privateKey: string } | null = null;
const resolved = new WeakMap<Config, WebPushKeys | null>();
const said = new Set<string>();
function once(p: Pick<Platform, "log">, key: string, fn: () => void) {
  if (said.has(key)) return;
  said.add(key);
  fn();
}

/**
 * The server's Web Push keys, or null when browser notifications are off (production without keys,
 * or keys that aren't a valid pair). Resolved once per configuration.
 */
export function webPushKeys(p: Pick<Platform, "cfg" | "log">): WebPushKeys | null {
  if (resolved.has(p.cfg)) return resolved.get(p.cfg) ?? null;
  const cfg = p.cfg;
  const pub = cfg.WEB_PUSH_VAPID_PUBLIC_KEY?.trim();
  const priv = cfg.WEB_PUSH_VAPID_PRIVATE_KEY?.trim();
  const subject = webPushSubject(cfg);
  let keys: WebPushKeys | null = null;
  if (pub && priv) {
    if (validPair(pub, priv)) keys = { publicKey: pub, privateKey: priv, subject, keyId: webPushKeyId(pub), ephemeral: false };
    else once(p, "invalid", () => p.log.error("Web push: WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY aren't a valid key pair, so browser notifications are off. Run setup-web-push.cmd to make a new pair."));
  } else if (pub || priv) {
    once(p, "half", () => p.log.error("Web push: only one of WEB_PUSH_VAPID_PUBLIC_KEY and WEB_PUSH_VAPID_PRIVATE_KEY is set, so browser notifications are off. Set both (setup-web-push.cmd)."));
  } else if (cfg.APP_ENV === "local" && cfg.NODE_ENV !== "production") {
    ephemeral ??= generateWebPushKeys();
    keys = { ...ephemeral, subject, keyId: webPushKeyId(ephemeral.publicKey), ephemeral: true };
    if (cfg.NODE_ENV !== "test") {
      once(p, "ephemeral", () =>
        p.log.warn(
          { keyId: keys!.keyId },
          "Web push: no keys in .env, so this local server made a temporary key pair. Browsers that turn notifications on now must turn them on again after a restart, and a separate worker process can't send them. Run setup-web-push.cmd once to keep one pair.",
        ),
      );
    }
  } else {
    once(p, "off", () => p.log.info("Web push: no keys configured (WEB_PUSH_VAPID_PUBLIC_KEY / WEB_PUSH_VAPID_PRIVATE_KEY), so browser notifications are off."));
  }
  resolved.set(cfg, keys);
  return keys;
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

/** https only, not too long, and not a private, loopback or internal host. */
export function assertPushEndpoint(raw: string): URL {
  if (raw.length > WEB_PUSH_ENDPOINT_MAX) throw new AppError("UNSAFE_URL", "Push endpoint too long", { userMessage: "This browser’s notification address can’t be used." });
  let url: URL;
  try {
    url = assertSafeUrl(raw);
  } catch {
    throw new AppError("UNSAFE_URL", "Push endpoint not allowed", { userMessage: "This browser’s notification address can’t be used." });
  }
  if (url.protocol !== "https:") throw new AppError("UNSAFE_URL", "Push endpoints must be https", { userMessage: "This browser’s notification address can’t be used." });
  return url;
}

function assertKeys(keys: WebPushSubscriptionInput["keys"]) {
  const p256dh = Buffer.from(keys.p256dh.replace(/=+$/, ""), "base64url");
  const auth = Buffer.from(keys.auth.replace(/=+$/, ""), "base64url");
  if (p256dh.length !== 65 || p256dh[0] !== 4 || auth.length !== 16) {
    throw new AppError("VALIDATION_FAILED", "Invalid push subscription keys", { userMessage: "This browser sent notification keys MuseLaunch can’t use." });
  }
}

/** "Chrome on Windows", "Safari on Mac", "Chrome on Android" (from a User-Agent; never stored in full). */
export function browserLabel(ua: string | undefined): string {
  const s = ua ?? "";
  const browser = /SamsungBrowser\//.test(s)
    ? "Samsung Internet"
    : /\bEdg(e|A|iOS)?\//.test(s)
      ? "Edge"
      : /\bOPR\/|\bOpera\b/.test(s)
        ? "Opera"
        : /\bFirefox\/|\bFxiOS\//.test(s)
          ? "Firefox"
          : /Chrome\/|\bCriOS\/|\bChromium\//.test(s)
            ? "Chrome"
            : /\bSafari\//.test(s)
              ? "Safari"
              : "Browser";
  const os = /Android/.test(s) ? "Android" : /iPad/.test(s) ? "iPad" : /iPhone|iPod/.test(s) ? "iPhone" : /Windows/.test(s) ? "Windows" : /CrOS/.test(s) ? "ChromeOS" : /Mac OS X|Macintosh/.test(s) ? "Mac" : /Linux/.test(s) ? "Linux" : null;
  return os ? `${browser} on ${os}` : browser;
}

/** A person's browsers, newest first. Unindexed equality query; sorted here. */
export async function webPushSubscriptionsOf(db: Db, userId: string): Promise<WebPushSubscription[]> {
  const page = await db.top("webPushSubscriptions").list({ where: [["userId", "==", userId]], limit: 100 });
  return page.items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export const webPushView = (s: WebPushSubscription): WebPushBrowserView => ({ id: s.id, label: s.label, createdAt: s.createdAt, ...(s.lastSentAt ? { lastSentAt: s.lastSentAt } : {}) });

/**
 * Save (or refresh) this browser's subscription for this person. A browser belongs to whoever
 * subscribed it last: the same endpoint saved by another person moves to them. At most
 * WEB_PUSH_MAX_PER_USER browsers per person (the least recently refreshed goes).
 */
export async function saveWebPushSubscription(p: Platform, userId: string, input: WebPushSubscriptionInput, userAgent?: string): Promise<WebPushSubscription> {
  const keys = webPushKeys(p);
  if (!keys) throw new AppError("PROVIDER_NOT_CONFIGURED", "Web push is off on this server", { userMessage: "Notifications in the browser aren’t set up on this server yet." });
  assertPushEndpoint(input.endpoint);
  assertKeys(input.keys);
  const id = webPushSubscriptionId(input.endpoint);
  const at = new Date().toISOString();
  const saved = await p.db.runTransaction(async (tx) => {
    const cur = await tx.getTop("webPushSubscriptions", id);
    const same = cur?.userId === userId;
    const doc: WebPushSubscription = {
      id,
      userId,
      endpoint: input.endpoint,
      keys: { p256dh: input.keys.p256dh, auth: input.keys.auth },
      label: browserLabel(userAgent).slice(0, 60),
      keyId: keys.keyId,
      createdAt: same ? cur.createdAt : at,
      updatedAt: at,
      ...(same && cur.lastSentAt ? { lastSentAt: cur.lastSentAt } : {}),
      failures: 0,
    };
    tx.setTop("webPushSubscriptions", id, doc);
    return { doc, moved: Boolean(cur && !same) };
  });
  if (saved.moved) p.log.info({ uid: userId, sub: id.slice(0, 8) }, "web push: a browser moved to another person");
  const mine = await webPushSubscriptionsOf(p.db, userId);
  for (const old of mine.slice(WEB_PUSH_MAX_PER_USER)) await p.db.top("webPushSubscriptions").delete(old.id);
  return saved.doc;
}

/** Remove one of this person's browsers (by its endpoint, or by id from Settings). Someone else's: NOT_FOUND. */
export async function removeWebPushSubscription(p: Platform, userId: string, ref: { endpoint: string } | { id: string }): Promise<void> {
  const id = "id" in ref ? ref.id : webPushSubscriptionId(ref.endpoint);
  const cur = await p.db.top("webPushSubscriptions").get(id);
  if (!cur || cur.userId !== userId) throw new AppError("NOT_FOUND", "Browser not found", { userMessage: "That browser isn’t getting notifications." });
  await p.db.top("webPushSubscriptions").delete(id);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface WebPushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array | null;
}
export type WebPushSender = (req: WebPushRequest, signal: AbortSignal) => Promise<{ status: number }>;

/** POST to the push service, connected to the address resolveSafe checked (no redirects). */
const networkSender: WebPushSender = async (req, signal) => {
  const url = assertPushEndpoint(req.endpoint);
  const target = await resolveSafe(url.hostname);
  const agent = new Agent({
    connect: { lookup: (_host, _opts, cb) => cb(null, [{ address: target.address, family: target.family }] as never, target.family) },
    headersTimeout: TIMEOUT_MS,
    bodyTimeout: TIMEOUT_MS,
  });
  try {
    const res = await undiciFetch(url, { method: "POST", headers: req.headers, body: req.body ?? undefined, redirect: "manual", dispatcher: agent, signal });
    await res.body?.cancel().catch(() => {});
    return { status: res.status };
  } finally {
    await agent.close().catch(() => {});
  }
};

let senderOverride: WebPushSender | null = null;
/** Tests (and only tests) replace the network call to the push services. */
export function setWebPushSender(f: WebPushSender | null): void {
  senderOverride = f;
}

export interface WebPushNote {
  kind: string;
  title: string;
  body: string;
  /** A path in the web app ("/w/<wid>/a/<appId>/home"). */
  url: string;
  tag: string;
  /** How long a push service keeps it for a browser that's offline (seconds). Default a day. */
  ttlSec?: number;
  urgency?: "very-low" | "low" | "normal" | "high";
}

export interface WebPushResult {
  /** Browsers the note went to. */
  browsers: number;
  sent: number;
  removed: number;
  failed: number;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const hostOf = (endpoint: string) => {
  try {
    return new URL(endpoint).host;
  } catch {
    return "invalid";
  }
};
/** Push services' `Topic` header (≤ 32 base64url characters): a newer message with the same topic replaces an undelivered one. */
const topicOf = (tag: string) => createHash("sha256").update(tag).digest("base64url").slice(0, 32);

async function failed(p: Platform, s: WebPushSubscription, why: { status?: number; reason: string }): Promise<boolean> {
  const failures = s.failures + 1;
  if (failures >= MAX_FAILURES) {
    await p.db.top("webPushSubscriptions").delete(s.id);
    p.log.warn({ host: hostOf(s.endpoint), sub: s.id.slice(0, 8), status: why.status, reason: why.reason }, "web push: subscription dropped after repeated refusals");
    return true;
  }
  await p.db.top("webPushSubscriptions").update(s.id, { failures });
  return false;
}

/** Send one note to these people's browsers. Never throws; failures are counted and logged. */
export async function sendWebPushToUsers(p: Platform, userIds: string[], note: WebPushNote): Promise<WebPushResult> {
  const out: WebPushResult = { browsers: 0, sent: 0, removed: 0, failed: 0 };
  const keys = webPushKeys(p);
  if (!keys) return out;
  const targets: WebPushSubscription[] = [];
  const seen = new Set<string>();
  for (const uid of [...new Set(userIds)]) {
    for (const s of await webPushSubscriptionsOf(p.db, uid)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      targets.push(s);
    }
  }
  out.browsers = targets.length;
  if (!targets.length) return out;
  const payload: WebPushPayload = { v: 1, title: clip(note.title, 120), body: clip(note.body, 240), url: note.url.slice(0, 500), tag: note.tag.slice(0, 100), kind: note.kind.slice(0, 40) };
  const json = JSON.stringify(payload);
  const send = senderOverride ?? networkSender;

  const one = async (s: WebPushSubscription) => {
    // Subscribed with another server key (a temporary local pair, or keys that were replaced): it can't be reached.
    if (s.keyId && s.keyId !== keys.keyId) {
      if (await failed(p, s, { reason: "subscribed with another server key" })) out.removed++;
      else out.failed++;
      return;
    }
    let req: WebPushRequest;
    try {
      const d = webpush.generateRequestDetails({ endpoint: s.endpoint, keys: s.keys }, json, {
        vapidDetails: { subject: keys.subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
        TTL: note.ttlSec ?? 86_400,
        urgency: note.urgency ?? "normal",
        topic: topicOf(note.tag),
      });
      const headers: Record<string, string> = {};
      // The body's length is set by the HTTP client itself.
      for (const [k, v] of Object.entries(d.headers)) if (k.toLowerCase() !== "content-length") headers[k] = String(v);
      req = { endpoint: d.endpoint, headers, body: d.body ? new Uint8Array(d.body) : null };
    } catch (err) {
      p.log.warn({ host: hostOf(s.endpoint), sub: s.id.slice(0, 8), err: { message: (err as Error).message } }, "web push: couldn't prepare the message");
      if (await failed(p, s, { reason: "couldn't encrypt" })) out.removed++;
      else out.failed++;
      return;
    }
    try {
      const res = await send(req, AbortSignal.timeout(TIMEOUT_MS));
      if (res.status >= 200 && res.status < 300) {
        out.sent++;
        await p.db.top("webPushSubscriptions").update(s.id, { lastSentAt: new Date().toISOString(), failures: 0 });
      } else if (res.status === 404 || res.status === 410) {
        // The browser unsubscribed, or the subscription expired: it's gone for good.
        await p.db.top("webPushSubscriptions").delete(s.id);
        out.removed++;
      } else {
        p.log.warn({ host: hostOf(s.endpoint), sub: s.id.slice(0, 8), status: res.status, kind: note.kind }, "web push: the push service refused it");
        // Busy or down (429, 5xx): not the subscription's fault.
        if (res.status !== 429 && res.status < 500 && (await failed(p, s, { status: res.status, reason: "refused" }))) out.removed++;
        else out.failed++;
      }
    } catch (err) {
      out.failed++;
      p.log.warn({ host: hostOf(s.endpoint), sub: s.id.slice(0, 8), err: { message: (err as Error).message }, kind: note.kind }, "web push: couldn't reach the push service");
    }
  };

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    await Promise.all(targets.slice(i, i + CONCURRENCY).map((s) => one(s).catch((err) => p.log.warn({ err: { message: (err as Error).message } }, "web push: send failed"))));
  }
  return out;
}
