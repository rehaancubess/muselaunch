import { z } from "zod";
import { Id, IsoDateTime } from "./common";

/**
 * Notifications in the browser (Web Push with VAPID keys), alongside the phone app's Expo pushes.
 *
 *  1. The web app asks the API for the server's public key (`GET /v1/push/web/config`).
 *  2. With the person's permission, the browser subscribes (its push service gives an endpoint and
 *     encryption keys) and the web app sends that subscription to `POST /v1/me/web-push`.
 *  3. The server stores it as `webPushSubscriptions/{sha256(endpoint)}` (top level) and sends each
 *     notification note to the person's linked phones and their browsers. A subscription the push
 *     service reports as gone (404/410) is removed.
 *
 * Endpoints and keys never leave the server again: lists show a short browser label and dates only.
 */

export const WEB_PUSH_ENDPOINT_MAX = 2048;
/** A person keeps at most this many browsers; the oldest one goes when a new one is added. */
export const WEB_PUSH_MAX_PER_USER = 20;

const base64url = (min: number, max: number) =>
  z
    .string()
    .min(min)
    .max(max)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, "Not base64url");

/** What `PushSubscription.toJSON()` gives in the browser. */
export const WebPushSubscriptionInput = z.object({
  endpoint: z.string().trim().min(12).max(WEB_PUSH_ENDPOINT_MAX),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    /** The browser's P-256 public key (65 bytes, uncompressed). */
    p256dh: base64url(80, 100),
    /** The 16-byte auth secret. */
    auth: base64url(16, 32),
  }),
});
export type WebPushSubscriptionInput = z.infer<typeof WebPushSubscriptionInput>;

/** `DELETE /v1/me/web-push`: the browser removing itself (its endpoint), or Settings removing one by id. */
export const RemoveWebPushRequest = z.union([z.object({ endpoint: z.string().trim().min(12).max(WEB_PUSH_ENDPOINT_MAX) }), z.object({ id: z.string().regex(/^[a-f0-9]{64}$/) })]);
export type RemoveWebPushRequest = z.infer<typeof RemoveWebPushRequest>;

/** `webPushSubscriptions/{sha256(endpoint)}` (top level). */
export const WebPushSubscription = z.object({
  /** sha256(endpoint), hex: the document id. */
  id: z.string().regex(/^[a-f0-9]{64}$/),
  userId: Id,
  endpoint: z.string().max(WEB_PUSH_ENDPOINT_MAX),
  keys: z.object({ p256dh: z.string().max(120), auth: z.string().max(60) }),
  /** "Chrome on Windows" (from the User-Agent when it subscribed). */
  label: z.string().max(60),
  /** Which server key it subscribed with (first 16 hex of sha256(public key)); another key can't reach it. */
  keyId: z.string().max(32).optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastSentAt: IsoDateTime.optional(),
  /** Failed sends in a row (reset by a successful one); the subscription is dropped after a few. */
  failures: z.number().int().nonnegative().default(0),
});
export type WebPushSubscription = z.infer<typeof WebPushSubscription>;

/** A browser as the person sees it in Settings (no endpoint, no keys). */
export const WebPushBrowserView = z.object({
  /** sha256(endpoint): the browser can work out which one is itself. */
  id: z.string(),
  label: z.string(),
  createdAt: IsoDateTime,
  lastSentAt: IsoDateTime.optional(),
});
export type WebPushBrowserView = z.infer<typeof WebPushBrowserView>;

/** `GET /v1/push/web/config`: whether this server sends browser notifications, and its public key. */
export const WebPushConfig = z.object({
  enabled: z.boolean(),
  publicKey: z.string().optional(),
});
export type WebPushConfig = z.infer<typeof WebPushConfig>;

/** What a pushed notification carries (the service worker shows it). */
export const WebPushPayload = z.object({
  v: z.literal(1),
  title: z.string().max(120),
  body: z.string().max(240),
  /** A path in the web app ("/w/<wid>/a/<appId>/home"); the service worker opens it on click. */
  url: z.string().max(500),
  /** Same tag = the newer notification replaces the older one (also used by in-page notices). */
  tag: z.string().max(100),
  kind: z.string().max(40),
});
export type WebPushPayload = z.infer<typeof WebPushPayload>;

/** The notification tag of a run (Autopilot or Create): one notification per run on screen at a time. */
export const runNotificationTag = (runId: string) => `ml-run-${runId}`.slice(0, 100);
