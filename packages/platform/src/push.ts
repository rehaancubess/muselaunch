import { can, type Capability, type Channel } from "@muselaunch/contracts";
import { z } from "zod";
import { devicesOf } from "./devices";
import type { Platform } from "./platform";

/**
 * Push notifications to linked phones, through Expo's push service (no secret needed; an optional
 * EXPO_ACCESS_TOKEN is sent when set, for projects with enhanced push security).
 *
 * Three moments, each opening the right screen of the phone app (`data.url` is an app path):
 *  - posts are ready to review (approval requested): at most one push per app per hour, saying how
 *    many posts wait right now ("2 posts are ready to review") → Home;
 *  - a post went live through a connected account → Results;
 *  - Always on's weekly summary is ready → Results.
 *
 * Only people with a linked phone that kept notifications on get them. A token Expo reports as
 * DeviceNotRegistered (app uninstalled) is removed, from the send tickets and later from the receipts.
 * Nothing here ever throws into the caller: a push that can't go out is logged and dropped.
 */

export const EXPO_PUSH_SEND_URL = "https://exp.host/--/api/v2/push/send";
export const EXPO_PUSH_RECEIPTS_URL = "https://exp.host/--/api/v2/push/getReceipts";
const CHUNK = 100;
const TIMEOUT_MS = 8_000;
/** "Posts ready to review": at most one push per app in this window. */
export const READY_PUSH_WINDOW_MS = 60 * 60_000;
/** Receipts are checked after this long (Expo's guidance), and dropped after a day. */
const RECEIPT_WAIT_MS = 15 * 60_000;
const RECEIPT_KEEP_MS = 24 * 3_600_000;

export type PushKind = "posts_ready" | "post_live" | "weekly_summary";

export interface PushNote {
  kind: PushKind;
  title: string;
  body: string;
  /** Where tapping it goes in the phone app (an app path, e.g. "/results?w=…&a=…"). */
  url: string;
  workspaceId: string;
  appId?: string;
}

export interface PushResult {
  /** Phones the message went to (notifications on and a push token). */
  devices: number;
  sent: number;
  removed: number;
  failed: number;
}

type PushResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type PushFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<PushResponse>;

let fetchOverride: PushFetch | null = null;
/** Tests (and only tests) replace the network call to Expo. */
export function setPushFetch(f: PushFetch | null): void {
  fetchOverride = f;
}
const pushFetch: PushFetch = (url, init) => (fetchOverride ?? (fetch as unknown as PushFetch))(url, init);

const ExpoTicket = z.object({
  status: z.enum(["ok", "error"]),
  id: z.string().optional(),
  message: z.string().optional(),
  details: z.object({ error: z.string().optional() }).passthrough().optional(),
});
const PendingReceipts = z.object({
  pending: z.array(z.object({ id: z.string().max(200), tokenHash: z.string().max(64), at: z.string() })).max(600),
});
const ReadyThrottle = z.object({ lastSentAt: z.string() });

const CHANNEL: Partial<Record<Channel, string>> = { instagram: "Instagram", facebook: "Facebook", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn", x: "X", threads: "Threads", reddit: "Reddit" };
export const channelName = (c: string) => CHANNEL[c as Channel] ?? c.charAt(0).toUpperCase() + c.slice(1);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const appPath = (screen: "" | "results", wid: string, appId: string) => `/${screen}?w=${encodeURIComponent(wid)}&a=${encodeURIComponent(appId)}`;

function headers(p: Platform): Record<string, string> {
  return {
    accept: "application/json",
    "content-type": "application/json",
    ...(p.cfg.EXPO_ACCESS_TOKEN ? { authorization: `Bearer ${p.cfg.EXPO_ACCESS_TOKEN}` } : {}),
  };
}

/** Remove a phone's push token (the app was uninstalled, or the token moved to another link). */
async function clearPushToken(p: Platform, tokenHash: string): Promise<void> {
  const d = await p.db.top("devices").get(tokenHash);
  if (!d?.push.token) return;
  await p.db.top("devices").update(tokenHash, { push: { enabled: d.push.enabled, updatedAt: new Date().toISOString() } });
}

async function rememberReceipts(p: Platform, items: { id: string; tokenHash: string }[]): Promise<void> {
  if (!items.length) return;
  const at = new Date().toISOString();
  await p.db.runTransaction(async (tx) => {
    const cur = (await tx.getGlobal("push-receipts", PendingReceipts))?.pending ?? [];
    const cutoff = Date.now() - RECEIPT_KEEP_MS;
    const next = [...cur.filter((r) => Date.parse(r.at) > cutoff), ...items.map((i) => ({ ...i, at }))].slice(-600);
    tx.setGlobal("push-receipts", PendingReceipts, { pending: next });
  });
}

/** Send one note to these people's linked phones. */
export async function sendPushToUsers(p: Platform, userIds: string[], note: PushNote): Promise<PushResult> {
  const out: PushResult = { devices: 0, sent: 0, removed: 0, failed: 0 };
  const now = Date.now();
  const targets: { token: string; tokenHash: string }[] = [];
  const seen = new Set<string>();
  for (const uid of [...new Set(userIds)]) {
    for (const d of await devicesOf(p.db, uid)) {
      if (!d.push.enabled || !d.push.token || Date.parse(d.expiresAt) <= now || seen.has(d.push.token)) continue;
      seen.add(d.push.token);
      targets.push({ token: d.push.token, tokenHash: d.tokenHash });
    }
  }
  out.devices = targets.length;
  const receipts: { id: string; tokenHash: string }[] = [];
  for (let i = 0; i < targets.length; i += CHUNK) {
    const batch = targets.slice(i, i + CHUNK);
    const messages = batch.map((t) => ({
      to: t.token,
      title: note.title.slice(0, 120),
      body: note.body.slice(0, 240),
      sound: "default",
      priority: "high",
      channelId: "default",
      data: { url: note.url, kind: note.kind, workspaceId: note.workspaceId, ...(note.appId ? { appId: note.appId } : {}) },
    }));
    try {
      const res = await pushFetch(EXPO_PUSH_SEND_URL, { method: "POST", headers: headers(p), body: JSON.stringify(messages), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const json = (await res.json().catch(() => null)) as { data?: unknown[] } | null;
      if (!res.ok || !Array.isArray(json?.data)) {
        out.failed += batch.length;
        p.log.warn({ status: res.status, kind: note.kind }, "push: Expo refused the batch");
        continue;
      }
      for (const [k, raw] of json.data.entries()) {
        const t = ExpoTicket.safeParse(raw);
        const target = batch[k];
        if (!target || !t.success) {
          out.failed++;
          continue;
        }
        if (t.data.status === "ok") {
          out.sent++;
          if (t.data.id) receipts.push({ id: t.data.id, tokenHash: target.tokenHash });
        } else if (t.data.details?.error === "DeviceNotRegistered") {
          await clearPushToken(p, target.tokenHash);
          out.removed++;
        } else {
          out.failed++;
          p.log.warn({ kind: note.kind, error: t.data.details?.error ?? t.data.message }, "push: Expo ticket error");
        }
      }
    } catch (err) {
      out.failed += batch.length;
      p.log.warn({ err: { message: (err as Error).message }, kind: note.kind }, "push: couldn't reach Expo");
    }
  }
  await rememberReceipts(p, receipts).catch((err) => p.log.warn({ err: { message: (err as Error).message } }, "push: couldn't keep receipt ids"));
  return out;
}

/**
 * Later errors come in receipts (Expo's guidance: check after ~15 minutes). Removes the tokens of
 * uninstalled apps. Run by the hourly Always on cron (and local-cron).
 */
export async function checkPushReceipts(p: Platform, now = Date.now()): Promise<{ checked: number; removed: number }> {
  const doc = await p.db.global("push-receipts", PendingReceipts).get();
  const due = (doc?.pending ?? []).filter((r) => now - Date.parse(r.at) >= RECEIPT_WAIT_MS && now - Date.parse(r.at) < RECEIPT_KEEP_MS).slice(0, 300);
  let removed = 0;
  const done = new Set<string>();
  if (due.length) {
    try {
      const res = await pushFetch(EXPO_PUSH_RECEIPTS_URL, { method: "POST", headers: headers(p), body: JSON.stringify({ ids: due.map((r) => r.id) }), signal: AbortSignal.timeout(TIMEOUT_MS) });
      const json = (await res.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
      if (res.ok && json?.data && typeof json.data === "object") {
        for (const r of due) {
          const receipt = ExpoTicket.safeParse(json.data[r.id]);
          // A receipt not there yet stays for the next check; one that's there is done either way.
          if (!receipt.success) continue;
          done.add(r.id);
          if (receipt.data.status === "error" && receipt.data.details?.error === "DeviceNotRegistered") {
            await clearPushToken(p, r.tokenHash);
            removed++;
          }
        }
      }
    } catch (err) {
      p.log.warn({ err: { message: (err as Error).message } }, "push: couldn't read receipts");
    }
  }
  await p.db.runTransaction(async (tx) => {
    const cur = (await tx.getGlobal("push-receipts", PendingReceipts))?.pending ?? [];
    const next = cur.filter((r) => !done.has(r.id) && now - Date.parse(r.at) < RECEIPT_KEEP_MS);
    if (next.length !== cur.length) tx.setGlobal("push-receipts", PendingReceipts, { pending: next });
  });
  return { checked: done.size, removed };
}

/** Active members of a workspace (optionally only those holding a capability). */
async function members(p: Platform, wid: string, cap?: Capability): Promise<string[]> {
  const page = await p.db.ws(wid).collection("members").list({ limit: 200 });
  return page.items.filter((m) => m.status === "active" && (!cap || can(m, cap))).map((m) => m.userId);
}

async function hasPhones(p: Platform, userIds: string[]): Promise<boolean> {
  for (const uid of userIds) if ((await devicesOf(p.db, uid)).some((d) => d.push.enabled && d.push.token)) return true;
  return false;
}

/** Someone in the workspace has a linked phone with notifications on (cheap check before building a summary). */
export async function workspaceHasPhones(p: Platform, wid: string): Promise<boolean> {
  try {
    return await hasPhones(p, await members(p, wid));
  } catch {
    return false;
  }
}

async function appName(p: Platform, wid: string, appId: string): Promise<string> {
  const app = await p.db.ws(wid).collection("apps").get(appId);
  return app?.name && app.name !== "New app" ? app.name : "MuseLaunch";
}

/** Run a notification without ever failing the work that caused it. */
async function quietly(p: Platform, what: string, fn: () => Promise<PushResult | null>): Promise<PushResult | null> {
  try {
    return await fn();
  } catch (err) {
    p.log.warn({ err: { message: (err as Error).message }, what }, "push: notification skipped");
    return null;
  }
}

/** Publish decisions waiting for this app right now (what Home counts as "posts to review"). */
export async function postsWaitingForReview(p: Platform, wid: string, appId: string, now = Date.now()): Promise<number> {
  const page = await p.db.ws(wid).collection("approvals").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return page.items.filter((a) => a.action === "publish" && a.status === "pending" && a.subject.entity === "scheduledPosts" && !(a.expiresAt && Date.parse(a.expiresAt) < now)).length;
}

/**
 * "2 posts are ready to review" (→ Home), to the people who can schedule them. At most one per app
 * per hour; the hour only starts when a push really goes to someone.
 */
export function notifyPostsReady(p: Platform, wid: string, appId: string, now = Date.now()): Promise<PushResult | null> {
  return quietly(p, "posts_ready", async () => {
    const waiting = await postsWaitingForReview(p, wid, appId, now);
    if (!waiting) return null;
    const people = await members(p, wid, "publish");
    if (!people.length || !(await hasPhones(p, people))) return null;
    const key = `push-ready-${wid}-${appId}`;
    const claimed = await p.db.runTransaction(async (tx) => {
      const last = await tx.getGlobal(key, ReadyThrottle);
      if (last && now - Date.parse(last.lastSentAt) < READY_PUSH_WINDOW_MS) return false;
      tx.setGlobal(key, ReadyThrottle, { lastSentAt: new Date(now).toISOString() });
      return true;
    });
    if (!claimed) return null;
    return sendPushToUsers(p, people, {
      kind: "posts_ready",
      title: await appName(p, wid, appId),
      body: `${plural(waiting, "post")} ${waiting === 1 ? "is" : "are"} ready to review`,
      url: appPath("", wid, appId),
      workspaceId: wid,
      appId,
    });
  });
}

/** "Your post is live on YouTube" (→ Results), to everyone in the workspace with a linked phone. */
export function notifyPostLive(p: Platform, wid: string, post: { appId: string; channel: string; title?: string }): Promise<PushResult | null> {
  return quietly(p, "post_live", async () => {
    const people = await members(p, wid);
    if (!people.length) return null;
    const title = post.title?.trim();
    return sendPushToUsers(p, people, {
      kind: "post_live",
      title: await appName(p, wid, post.appId),
      body: `Your post is live on ${channelName(post.channel)}${title ? `: “${title.slice(0, 80)}”` : ""}. Results counts what it brings in.`,
      url: appPath("results", wid, post.appId),
      workspaceId: wid,
      appId: post.appId,
    });
  });
}

/** Always on's weekly summary (→ Results): only counts from the stored summary. */
export function notifyWeeklySummary(p: Platform, wid: string, appId: string, s: { posted: number; queued: number; needsYou: number; findings: number }): Promise<PushResult | null> {
  return quietly(p, "weekly_summary", async () => {
    const people = await members(p, wid);
    if (!people.length) return null;
    const parts = [
      s.posted ? `${plural(s.posted, "post")} went out` : "No posts went out",
      s.queued ? `${s.queued} lined up` : null,
      s.needsYou ? `${s.needsYou} waiting for your OK` : null,
      s.findings ? `${plural(s.findings, "new idea")} with sources` : null,
    ].filter(Boolean);
    return sendPushToUsers(p, people, {
      kind: "weekly_summary",
      title: `Your week: ${await appName(p, wid, appId)}`,
      body: `${parts.join(" · ")}.`,
      url: appPath("results", wid, appId),
      workspaceId: wid,
      appId,
    });
  });
}
