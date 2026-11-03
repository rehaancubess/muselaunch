"use client";
/**
 * Notifications in this browser (Web Push), so they arrive with every MuseLaunch tab closed.
 *
 *   isWebPushSupported()  this browser can do it (service workers + Push API, secure page)
 *   getWebPushState()     "unsupported" | "server-off" | "denied" | "off" | "on"
 *   enableWebPush()       asks permission, registers /sw.js, subscribes with the server's public key
 *                         and sends the subscription to POST /v1/me/web-push
 *   disableWebPush()      removes it from the server and unsubscribes this browser
 *
 * "on" means this browser holds a subscription made with the server's current key for the person
 * signed in here. Signing out (auth-provider) turns it off, so a shared computer stops getting the
 * previous person's notes. iPhone and iPad Safari only allow it for sites added to the Home Screen:
 * there it reports "unsupported" and the UI points to the phone app instead.
 */
import type { WebPushBrowserView, WebPushConfig } from "@muselaunch/contracts";
import { useCallback, useEffect, useState } from "react";
import { api, request } from "./api";

export type WebPushState = "unsupported" | "server-off" | "denied" | "off" | "on";

export const WEB_PUSH_PATH = "/v1/me/web-push";
const CONFIG_PATH = "/v1/push/web/config";
const SW_URL = "/sw.js";
/** Who turned notifications on in this browser (a person signing in later doesn't inherit them). */
const OWNER_KEY = "ml.webPush.owner";

export function isWebPushSupported(): boolean {
  return typeof window !== "undefined" && window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

/** iPhone or iPad (iPadOS reports itself as a Mac with touch). */
export function isAppleMobile(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

let config: Promise<WebPushConfig> | null = null;
/** The server's answer, once per page load (a failed request is asked again next time). */
export function webPushConfig(): Promise<WebPushConfig> {
  config ??= api.get<WebPushConfig>(CONFIG_PATH).catch((err) => {
    config = null;
    throw err;
  });
  return config;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The subscription was made with this server key (a temporary local key, or replaced keys, can't reach it). */
function madeWith(sub: PushSubscription, publicKey: string): boolean {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  const a = new Uint8Array(k);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function readOwner(): string | null {
  try {
    return localStorage.getItem(OWNER_KEY);
  } catch {
    return null;
  }
}
function writeOwner(uid: string | null) {
  try {
    if (uid) localStorage.setItem(OWNER_KEY, uid);
    else localStorage.removeItem(OWNER_KEY);
  } catch {
    /* storage unavailable: ownership can't be remembered */
  }
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/** sha256(endpoint) as hex: the id the server lists this browser under. */
export async function subscriptionId(endpoint: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** This browser's id in the server's list, when it has a subscription. */
export async function thisBrowserId(): Promise<string | null> {
  if (!isWebPushSupported()) return null;
  const sub = await currentSubscription().catch(() => null);
  return sub ? subscriptionId(sub.endpoint) : null;
}

const listeners = new Set<() => void>();
const changed = () => listeners.forEach((f) => f());
/** The subscription was sent to the server during this page load. */
let synced = false;

/** `uid`: the person signed in here (a subscription someone else turned on counts as "off" for them). */
export async function getWebPushState(uid?: string | null): Promise<WebPushState> {
  if (!isWebPushSupported()) return "unsupported";
  const cfg = await webPushConfig().catch(() => null);
  if (!cfg?.enabled || !cfg.publicKey) return "server-off";
  if (Notification.permission === "denied") return "denied";
  if (Notification.permission !== "granted") return "off";
  const sub = await currentSubscription().catch(() => null);
  if (!sub || !madeWith(sub, cfg.publicKey)) return "off";
  const owner = readOwner();
  if (uid && owner && owner !== uid) return "off";
  return "on";
}

/** How long the browser's own push service may take to register it (it can hang on a blocked network). */
const SUBSCRIBE_TIMEOUT_MS = 20_000;

/** Subscribe with the browser's push service, in plain words when it can't. */
async function subscribe(reg: ServiceWorkerRegistration, publicKey: string): Promise<PushSubscription> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("This browser’s notification service didn’t answer. Check your connection and try again.")), SUBSCRIBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }), late]);
  } catch (err) {
    const name = (err as DOMException)?.name;
    if (name === "NotAllowedError") throw new Error("This browser won’t allow notifications in this window. Private windows can’t get them: try a normal window.");
    if (name === "AbortError") throw new Error("This browser couldn’t reach its notification service. Try again in a moment.");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function forget(sub: PushSubscription) {
  await request("DELETE", WEB_PUSH_PATH, { body: { endpoint: sub.endpoint } }).catch(() => undefined);
  await sub.unsubscribe().catch(() => false);
}

/** Ask permission (when not given yet), subscribe this browser and tell the server. Returns the new state. */
export async function enableWebPush(uid?: string | null): Promise<WebPushState> {
  if (!isWebPushSupported()) return "unsupported";
  const cfg = await webPushConfig();
  if (!cfg.enabled || !cfg.publicKey) return "server-off";
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission === "denied") {
    changed();
    return "denied";
  }
  if (permission !== "granted") return "off";
  await navigator.serviceWorker.register(SW_URL, { scope: "/", updateViaCache: "none" });
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  // Made with another server key, or turned on by someone else signed in here before: start afresh.
  if (sub && (!madeWith(sub, cfg.publicKey) || (uid && readOwner() && readOwner() !== uid))) {
    await sub.unsubscribe().catch(() => false);
    sub = null;
  }
  sub ??= await subscribe(reg, cfg.publicKey);
  await api.post(WEB_PUSH_PATH, sub.toJSON());
  writeOwner(uid ?? null);
  synced = true;
  changed();
  return "on";
}

/** Stop notifications in this browser (the server forgets it too). */
export async function disableWebPush(): Promise<WebPushState> {
  if (!isWebPushSupported()) return "unsupported";
  const sub = await currentSubscription().catch(() => null);
  if (sub) await forget(sub);
  writeOwner(null);
  changed();
  return getWebPushState();
}

/**
 * Once per page load, while notifications are on here: send the subscription again (the server may
 * have lost it, or the browser replaced it). A subscription someone else turned on is dropped instead.
 */
export async function syncWebPush(uid?: string | null): Promise<void> {
  if (synced || !uid || !isWebPushSupported() || Notification.permission !== "granted") return;
  synced = true;
  const cfg = await webPushConfig().catch(() => null);
  const sub = await currentSubscription().catch(() => null);
  if (!cfg?.enabled || !cfg.publicKey || !sub) return;
  const owner = readOwner();
  if (owner && owner !== uid) {
    // Signed in as someone else: this browser stops getting the previous person's notes.
    await sub.unsubscribe().catch(() => false);
    writeOwner(null);
    changed();
    return;
  }
  if (!madeWith(sub, cfg.publicKey)) return;
  await api.post(WEB_PUSH_PATH, sub.toJSON()).catch(() => undefined);
  if (!owner) writeOwner(uid);
}

/** React: this browser's state for the signed-in person, kept current across components. */
export function useWebPush(uid?: string | null): { state: WebPushState | null; busy: boolean; enable: () => Promise<WebPushState>; disable: () => Promise<WebPushState>; refresh: () => void } {
  const [state, setState] = useState<WebPushState | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(() => {
    void getWebPushState(uid).then(setState);
  }, [uid]);
  useEffect(() => {
    refresh();
    listeners.add(refresh);
    void syncWebPush(uid);
    return () => {
      listeners.delete(refresh);
    };
  }, [refresh, uid]);
  const run = useCallback(async (fn: () => Promise<WebPushState>) => {
    setBusy(true);
    try {
      const s = await fn();
      setState(s);
      return s;
    } finally {
      setBusy(false);
    }
  }, []);
  return { state, busy, refresh, enable: useCallback(() => run(() => enableWebPush(uid)), [run, uid]), disable: useCallback(() => run(disableWebPush), [run]) };
}

export type { WebPushBrowserView };
