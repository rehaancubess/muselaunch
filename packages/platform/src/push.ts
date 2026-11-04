import { can, runNotificationTag, shortAppName, type Capability, type Channel } from "@muselaunch/contracts";
import { z } from "zod";
import { devicesOf } from "./devices";
import type { Platform } from "./platform";
import { sendWebPushToUsers, webPushKeys, webPushSubscriptionsOf, type WebPushResult } from "./web-push";

/**
 * Notifications: one note reaches the person's linked phones (Expo's push service; no secret needed,
 * an optional EXPO_ACCESS_TOKEN is sent when set) and the browsers they turned notifications on in
 * (Web Push, web-push.ts), so they arrive with every MuseLaunch tab closed.
 *
 * The moments, each opening the right screen (`url`: a phone app path; `webUrl`: a web app path):
 *  - posts are ready to review (approval requested): at most one per app per hour, saying how many
 *    posts wait right now ("2 posts are ready to review") → Home;
 *  - a post went live through a connected account → Results;
 *  - Always on's weekly summary is ready → Results;
 *  - the first run finished studying the app ("Muse has finished studying Pocket Play") → Home;
 *  - the first run's videos are ready ("2 posts are waiting for your OK"), instead of the posts-ready
 *    note for that batch → Home;
 *  - a run (Autopilot or Create) stops for a decision ("Muse needs you for a moment"), once per
 *    decision → Home, or the Create page for a Create video;
 *  - a Create video is finished ("Your video is ready") → the Create page.
 * The once-per-run moments are claimed in `ops/push-run-<wid>-<runId>`, so a step that runs twice
 * never notifies twice.
 *
 * Phones: only those with notifications on. A token Expo reports as DeviceNotRegistered (app
 * uninstalled) is removed, from the send tickets and later from the receipts. Browsers: a
 * subscription the push service reports as gone is removed. Nothing here ever throws into the
 * caller: a note that can't go out is logged and dropped.
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

export type PushKind = "posts_ready" | "post_live" | "weekly_summary" | "first_run_studied" | "first_videos_ready" | "needs_you" | "video_ready" | "test";

export interface PushNote {
  kind: PushKind;
  title: string;
  body: string;
  /** Where tapping it goes in the phone app (an app path, e.g. "/results?w=…&a=…"). */
  url: string;
  /** Where clicking it goes in the web app (a full path, e.g. "/w/<wid>/a/<appId>/home"). Default: the app's Home. */
  webUrl?: string;
  /** Same tag = a newer browser notification replaces the older one. Default: kind + app. */
  tag?: string;
  workspaceId: string;
  appId?: string;
  /** Browser pushes: how long a push service keeps it for an offline browser (seconds). */
  ttlSec?: number;
  urgency?: "normal" | "high";
}

export interface PushResult {
  /** Phones the message went to (notifications on and a push token). */
  devices: number;
  /** Browsers the message went to. */
  browsers: number;
  /** Phones and browsers together (each half also below). */
  sent: number;
  removed: number;
  failed: number;
  phone: { sent: number; removed: number; failed: number };
  web: { sent: number; removed: number; failed: number };
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

const webHome = (wid: string, appId?: string) => (appId ? `/w/${encodeURIComponent(wid)}/a/${encodeURIComponent(appId)}/home` : `/w/${encodeURIComponent(wid)}`);

/**
 * Send one note to these people's linked phones and their browsers. Never throws: each half that
 * fails is logged and counted as nothing sent.
 */
export async function sendPushToUsers(p: Platform, userIds: string[], note: PushNote): Promise<PushResult> {
  const none = { sent: 0, removed: 0, failed: 0 };
  const [phone, web] = await Promise.all([
    sendPhonePush(p, userIds, note).catch((err) => {
      p.log.warn({ err: { message: (err as Error).message }, kind: note.kind }, "push: phones skipped");
      return { devices: 0, ...none };
    }),
    sendWebPushToUsers(p, userIds, {
      kind: note.kind,
      title: note.title,
      body: note.body,
      url: note.webUrl ?? webHome(note.workspaceId, note.appId),
      tag: note.tag ?? `ml-${note.kind}-${note.appId ?? note.workspaceId}`,
      ttlSec: note.ttlSec,
      urgency: note.urgency,
    }).catch((err): WebPushResult => {
      p.log.warn({ err: { message: (err as Error).message }, kind: note.kind }, "push: browsers skipped");
      return { browsers: 0, ...none };
    }),
  ]);
  return {
    devices: phone.devices,
    browsers: web.browsers,
    sent: phone.sent + web.sent,
    removed: phone.removed + web.removed,
    failed: phone.failed + web.failed,
    phone: { sent: phone.sent, removed: phone.removed, failed: phone.failed },
    web: { sent: web.sent, removed: web.removed, failed: web.failed },
  };
}

/** Send one note to these people's linked phones (Expo). */
async function sendPhonePush(p: Platform, userIds: string[], note: PushNote): Promise<{ devices: number; sent: number; removed: number; failed: number }> {
  const out = { devices: 0, sent: 0, removed: 0, failed: 0 };
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

/** "Notifications are on" to the caller's own browsers (Settings → Notifications → Send a test). */
export function sendWebPushTest(p: Platform, userId: string): Promise<WebPushResult> {
  return sendWebPushToUsers(p, [userId], {
    kind: "test",
    title: "Notifications are on",
    body: "MuseLaunch will tell you here when your videos are ready or Muse needs you.",
    url: "/",
    tag: "ml-test",
    ttlSec: 600,
  });
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

/** Someone here has a linked phone with notifications on, or a browser with notifications on. */
async function hasReceivers(p: Platform, userIds: string[]): Promise<boolean> {
  const now = Date.now();
  const web = webPushKeys(p) !== null;
  for (const uid of userIds) {
    if ((await devicesOf(p.db, uid)).some((d) => d.push.enabled && d.push.token && Date.parse(d.expiresAt) > now)) return true;
    if (web && (await webPushSubscriptionsOf(p.db, uid)).length) return true;
  }
  return false;
}

/** Someone in the workspace gets notifications (a phone or a browser): cheap check before building a summary. */
export async function workspaceHasReceivers(p: Platform, wid: string): Promise<boolean> {
  try {
    return await hasReceivers(p, await members(p, wid));
  } catch {
    return false;
  }
}

/**
 * Who a run's notes go to: the person who started it (while still an active member) and the active
 * members holding every one of `caps`.
 */
async function runRecipients(p: Platform, wid: string, startedBy: string | undefined, caps: Capability[]): Promise<string[]> {
  const page = await p.db.ws(wid).collection("members").list({ limit: 200 });
  const out = new Set<string>();
  for (const m of page.items) {
    if (m.status !== "active") continue;
    if (m.userId === startedBy || (caps.length && caps.every((c) => can(m, c)))) out.add(m.userId);
  }
  return [...out];
}

async function appName(p: Platform, wid: string, appId: string): Promise<string> {
  const app = await p.db.ws(wid).collection("apps").get(appId);
  return app?.name && app.name !== "New app" ? app.name : "MuseLaunch";
}

const RunMoments = z.object({ sent: z.array(z.string().max(200)).max(100) });

/** Claim a once-per-run moment ("studied", "needs:<decision>", …): true the first time only. */
async function claimMoment(p: Platform, wid: string, runId: string, moment: string): Promise<boolean> {
  const key = `push-run-${wid}-${runId}`.slice(0, 400);
  return p.db.runTransaction(async (tx) => {
    const cur = (await tx.getGlobal(key, RunMoments))?.sent ?? [];
    if (cur.includes(moment)) return false;
    tx.setGlobal(key, RunMoments, { sent: [...cur, moment.slice(0, 200)].slice(-100) });
    return true;
  });
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
    if (!people.length || !(await hasReceivers(p, people))) return null;
    if (!(await claimReadyWindow(p, wid, appId, now))) return null;
    return sendPushToUsers(p, people, {
      kind: "posts_ready",
      title: await appName(p, wid, appId),
      body: `${plural(waiting, "post")} ${waiting === 1 ? "is" : "are"} ready to review`,
      url: appPath("", wid, appId),
      webUrl: webAppPath(wid, appId, "home"),
      tag: `ml-posts-ready-${appId}`,
      workspaceId: wid,
      appId,
    });
  });
}

/** Start the app's "posts ready" hour (false: one already went out within it). */
function claimReadyWindow(p: Platform, wid: string, appId: string, now: number): Promise<boolean> {
  const key = `push-ready-${wid}-${appId}`;
  return p.db.runTransaction(async (tx) => {
    const last = await tx.getGlobal(key, ReadyThrottle);
    if (last && now - Date.parse(last.lastSentAt) < READY_PUSH_WINDOW_MS) return false;
    tx.setGlobal(key, ReadyThrottle, { lastSentAt: new Date(now).toISOString() });
    return true;
  });
}

const webAppPath = (wid: string, appId: string, page: string) => `/w/${encodeURIComponent(wid)}/a/${encodeURIComponent(appId)}/${page}`;
const createPage = (wid: string, appId: string, campaignId: string) => webAppPath(wid, appId, `create?run=${encodeURIComponent(campaignId)}`);

/** A run, as far as its notifications go (an Autopilot loop, or a Create video's campaign). */
export interface RunRef {
  id: string;
  appId: string;
  /** Who started it (gets its notes while still an active member). */
  startedBy?: string;
}

/**
 * First run, "Muse has finished studying Pocket Play" (→ Home): the run moved past the ideas into
 * making the videos. Once per run; to its starter and whoever can make content.
 */
export function notifyFirstRunStudied(p: Platform, wid: string, run: RunRef): Promise<PushResult | null> {
  return quietly(p, "first_run_studied", async () => {
    const people = await runRecipients(p, wid, run.startedBy, ["content.write"]);
    if (!people.length || !(await hasReceivers(p, people)) || !(await claimMoment(p, wid, run.id, "studied"))) return null;
    return sendPushToUsers(p, people, {
      kind: "first_run_studied",
      title: `Muse has finished studying ${shortAppName(await appName(p, wid, run.appId))}`,
      body: "Now making your first videos.",
      url: appPath("", wid, run.appId),
      webUrl: webAppPath(wid, run.appId, "home"),
      tag: runNotificationTag(run.id),
      workspaceId: wid,
      appId: run.appId,
      ttlSec: 6 * 3600,
    });
  });
}

/**
 * First run, "Your first videos are ready" (→ Home) when it drafts its posts: "2 posts are waiting
 * for your OK." It stands in for the "posts ready" note of that batch and starts the app's posts-ready
 * hour, so the two never both arrive. Once per run; to its starter and whoever can schedule posts.
 */
export function notifyFirstVideosReady(p: Platform, wid: string, run: RunRef, now = Date.now()): Promise<PushResult | null> {
  return quietly(p, "first_videos_ready", async () => {
    const people = await runRecipients(p, wid, run.startedBy, ["publish"]);
    if (!people.length || !(await hasReceivers(p, people)) || !(await claimMoment(p, wid, run.id, "ready"))) return null;
    await claimReadyWindow(p, wid, run.appId, now);
    const waiting = await postsWaitingForReview(p, wid, run.appId, now);
    return sendPushToUsers(p, people, {
      kind: "first_videos_ready",
      title: "Your first videos are ready",
      body: waiting ? `${plural(waiting, "post")} ${waiting === 1 ? "is" : "are"} waiting for your OK.` : "Open MuseLaunch to watch them.",
      url: appPath("", wid, run.appId),
      webUrl: webAppPath(wid, run.appId, "home"),
      tag: runNotificationTag(run.id),
      workspaceId: wid,
      appId: run.appId,
    });
  });
}

/**
 * "Muse needs you for a moment" when a run stops for a decision: once per decision (`decisionKey`,
 * e.g. the approval id or the Create step's key). To the starter and whoever holds `caps` (who can
 * answer it). An Autopilot run opens Home; a Create video opens the Create page on that video.
 */
export function notifyRunNeedsYou(
  p: Platform,
  wid: string,
  run: RunRef & { kind: "autopilot" | "create" },
  decision: { key: string; what?: string; caps: Capability[] },
): Promise<PushResult | null> {
  return quietly(p, "needs_you", async () => {
    const people = await runRecipients(p, wid, run.startedBy, decision.caps);
    if (!people.length || !(await hasReceivers(p, people)) || !(await claimMoment(p, wid, run.id, `needs:${decision.key}`))) return null;
    const name = shortAppName(await appName(p, wid, run.appId));
    const what = decision.what?.trim().replace(/[.\s]+$/, "");
    return sendPushToUsers(p, people, {
      kind: "needs_you",
      title: "Muse needs you for a moment",
      body: what ? `${name}: ${what.slice(0, 200)}.` : `${name}: one quick decision, then Muse carries on.`,
      url: appPath("", wid, run.appId),
      webUrl: run.kind === "create" ? createPage(wid, run.appId, run.id) : webAppPath(wid, run.appId, "home"),
      tag: runNotificationTag(run.id),
      workspaceId: wid,
      appId: run.appId,
      urgency: "high",
    });
  });
}

/**
 * A Create run is finished: "Your video is ready" with its title (→ the Create page). Once per run.
 * `noun` names what the run made when it isn't a video ("Your carousel is ready", "Your screenshots are ready").
 */
export function notifyVideoReady(p: Platform, wid: string, run: RunRef, video: { title?: string; noun?: { one: string; plural: boolean } }): Promise<PushResult | null> {
  return quietly(p, "video_ready", async () => {
    const people = await runRecipients(p, wid, run.startedBy, ["publish"]);
    if (!people.length || !(await hasReceivers(p, people)) || !(await claimMoment(p, wid, run.id, "done"))) return null;
    const title = video.title?.trim();
    const noun = video.noun ?? { one: "video", plural: false };
    const ready = noun.one === "video" ? "ready to watch and post" : "ready to post";
    return sendPushToUsers(p, people, {
      kind: "video_ready",
      title: `Your ${noun.one} ${noun.plural ? "are" : "is"} ready`,
      body: title ? `“${title.slice(0, 90)}” is ${ready}.` : `${shortAppName(await appName(p, wid, run.appId))}: ${ready}.`,
      url: appPath("", wid, run.appId),
      webUrl: createPage(wid, run.appId, run.id),
      tag: runNotificationTag(run.id),
      workspaceId: wid,
      appId: run.appId,
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
      webUrl: webAppPath(wid, post.appId, "results"),
      tag: `ml-post-live-${post.appId}-${post.channel}`,
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
      webUrl: webAppPath(wid, appId, "results"),
      tag: `ml-weekly-${appId}`,
      workspaceId: wid,
      appId,
    });
  });
}
