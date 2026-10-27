import { Channel, IsoDateTime, type ScheduledPost } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, toAppError, type Platform } from "@muselaunch/platform";
import { z } from "zod";
import { DAY_MS } from "../util";
import { purgeExpiredPendingConnections } from "../connections";
import { enqueuePublish, statusLabel } from "./posts";

// ---------------------------------------------------------------------------
// Time zone helpers (Intl only, no tz database dependency)
// ---------------------------------------------------------------------------

export function assertTimeZone(tz: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    throw new AppError("BAD_REQUEST", `Unknown time zone ${tz}`);
  }
}

function zonedParts(date: Date, tz: string) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" });
  const parts = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.weekday!);
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour), min: Number(parts.minute), s: Number(parts.second), weekday };
}

const offsetMs = (date: Date, tz: string) => {
  const z = zonedParts(date, tz);
  return Date.UTC(z.y, z.m - 1, z.d, z.h, z.min, z.s) - Math.floor(date.getTime() / 1000) * 1000;
};

/** Wall-clock time in `tz` → UTC instant. */
export function zonedToUtc(y: number, m: number, d: number, h: number, min: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let utc = guess - offsetMs(new Date(guess), tz);
  const second = guess - offsetMs(new Date(utc), tz);
  if (second !== utc) utc = second;
  return new Date(utc);
}

export const localDate = (iso: string, tz: string) => {
  const z = zonedParts(new Date(iso), tz);
  return `${z.y}-${String(z.m).padStart(2, "0")}-${String(z.d).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export const CalendarQuery = z.object({
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  timezone: z.string().max(64).optional(),
  channel: Channel.optional(),
  campaignId: z.string().max(128).optional(),
});

export async function calendar(ws: WorkspaceDb, appId: string, q: z.infer<typeof CalendarQuery>, defaultTz = "UTC", now = Date.now()) {
  const tz = assertTimeZone(q.timezone ?? defaultTz);
  const from = q.from ? Date.parse(q.from) : now - 7 * DAY_MS;
  const to = q.to ? Date.parse(q.to) : now + 35 * DAY_MS;
  if (to <= from || to - from > 120 * DAY_MS) throw new AppError("BAD_REQUEST", "Calendar range must be positive and at most 120 days");
  const posts = (await ws.collection("scheduledPosts").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 500 })).items.filter(
    (p) => (!q.channel || p.channel === q.channel) && (!q.campaignId || p.campaignId === q.campaignId),
  );
  const pubIds = posts.map((p) => p.publicationId).filter((x): x is string => Boolean(x));
  const pubs = new Map((await ws.collection("publications").getMany(pubIds)).map((x) => [x.id, x]));
  const when = (p: ScheduledPost) => (p.publicationId ? pubs.get(p.publicationId)?.publishedAt : undefined) ?? p.scheduledAt;
  const item = (p: ScheduledPost) => {
    const pub = p.publicationId ? pubs.get(p.publicationId) : undefined;
    return {
      id: p.id,
      campaignId: p.campaignId,
      channel: p.channel,
      mode: p.mode,
      status: p.status,
      statusLabel: statusLabel(p),
      title: p.title ?? p.caption.split("\n")[0]?.slice(0, 120),
      scheduledAt: p.scheduledAt,
      at: when(p),
      reminderAt: p.reminderAt,
      thumbnailAssetId: p.thumbnailAssetId ?? p.assetIds[0],
      approvalId: p.approvalId,
      publication: pub ? { id: pub.id, mode: pub.mode, remoteUrl: pub.remoteUrl, publishedAt: pub.publishedAt } : undefined,
      lastError: p.lastError,
    };
  };
  const inRange = posts.filter((p) => {
    const at = when(p);
    return at && Date.parse(at) >= from && Date.parse(at) < to;
  });
  const days: Record<string, ReturnType<typeof item>[]> = {};
  for (const p of inRange.sort((a, b) => when(a)!.localeCompare(when(b)!))) (days[localDate(when(p)!, tz)] ??= []).push(item(p));
  const unscheduled = posts.filter((p) => !when(p) && !["cancelled"].includes(p.status)).map(item);
  const reminders = posts.filter((p) => p.reminderAt && p.status === "manual_post_needed").map((p) => ({ postId: p.id, at: p.reminderAt!, due: Date.parse(p.reminderAt!) <= now, channel: p.channel }));
  const counts = posts.reduce<Record<string, number>>((acc, p) => ((acc[p.status] = (acc[p.status] ?? 0) + 1), acc), {});
  return { timezone: tz, from: new Date(from).toISOString(), to: new Date(to).toISOString(), days, unscheduled, reminders, counts };
}

// ---------------------------------------------------------------------------
// Suggested times (always labelled as suggestions)
// ---------------------------------------------------------------------------

/**
 * General starting points only — not research and not this app's data. Shown with that label.
 * Product Hunt's day resets at 12:01 AM Pacific (a platform rule, not a heuristic).
 */
const HEURISTICS: Partial<Record<Channel, { days: number[]; hours: number[]; tz?: string; why: string }>> = {
  instagram: { days: [2, 3, 4], hours: [11, 19], why: "Midweek late-morning and evening slots are common starting points for Reels." },
  tiktok: { days: [2, 3, 4, 5], hours: [18, 20], why: "Evening slots are a common starting point for short video." },
  youtube: { days: [4, 5, 6], hours: [15], why: "Publishing mid-afternoon late in the week gives a video time to be picked up before evening viewing." },
  linkedin: { days: [2, 3, 4], hours: [8, 9], why: "Weekday mornings are a common starting point for professional audiences." },
  x: { days: [1, 2, 3, 4, 5], hours: [9, 12], why: "Weekday mornings and lunchtime are common starting points." },
  facebook: { days: [2, 3, 4], hours: [10, 13], why: "Weekday late morning is a common starting point for Pages." },
  threads: { days: [2, 3, 4], hours: [12, 19], why: "Midday and evening are common starting points." },
  reddit: { days: [1, 2, 3, 4], hours: [8], why: "Early weekday mornings in the community's main time zone give a post the day to gather discussion. Check the subreddit's rules first." },
  producthunt: { days: [2, 3, 4], hours: [0], tz: "America/Los_Angeles", why: "Product Hunt's launch day starts at 12:01 AM Pacific; launching at the start gives the full 24 hours." },
  hackernews: { days: [1, 2, 3, 4], hours: [8], tz: "America/New_York", why: "Weekday mornings US Eastern are a common starting point for Show HN posts." },
};

export const SuggestTimesQuery = z.object({ channel: Channel, timezone: z.string().max(64).optional(), count: z.coerce.number().int().min(1).max(6).default(3) });

export async function suggestTimes(ws: WorkspaceDb, appId: string, q: z.infer<typeof SuggestTimesQuery>, defaultTz = "UTC", now = Date.now()) {
  const tz = assertTimeZone(q.timezone ?? defaultTz);
  const h = HEURISTICS[q.channel] ?? { days: [2, 3, 4], hours: [10], why: "A generic weekday-morning starting point." };
  const slotTz = h.tz ?? tz;

  // Own data: views per publication on this channel, grouped by local weekday. Correlation only.
  const pubs = (await ws.collection("publications").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((x) => x.channel === q.channel);
  let own: { weekday: number; hour: number; meanViews: number; samples: number; totalPosts: number } | undefined;
  if (pubs.length >= 6) {
    const views = (await ws.collection("metricObservations").list({ where: [["appId", "==", appId], ["metric", "==", "views"]], orderBy: { field: "windowStart", dir: "desc" }, limit: 1000 })).items.filter(
      (o) => o.publicationId && o.attribution === "platform_reported",
    );
    const byPub = new Map<string, number>();
    for (const o of views) byPub.set(o.publicationId!, Math.max(byPub.get(o.publicationId!) ?? 0, o.value));
    const buckets = new Map<number, { sum: number; n: number; hours: number[] }>();
    for (const pub of pubs) {
      const v = byPub.get(pub.id);
      if (v === undefined) continue;
      const z = zonedParts(new Date(pub.publishedAt), tz);
      const b = buckets.get(z.weekday) ?? { sum: 0, n: 0, hours: [] };
      b.sum += v;
      b.n++;
      b.hours.push(z.h);
      buckets.set(z.weekday, b);
    }
    const ranked = [...buckets.entries()].filter(([, b]) => b.n >= 2).sort((a, b) => b[1].sum / b[1].n - a[1].sum / a[1].n);
    if (ranked.length >= 2) {
      const [weekday, b] = ranked[0]!;
      const hour = b.hours.sort((x, y) => x - y)[Math.floor(b.hours.length / 2)]!;
      own = { weekday, hour, meanViews: Math.round(b.sum / b.n), samples: b.n, totalPosts: [...buckets.values()].reduce((s, x) => s + x.n, 0) };
    }
  }

  const existing = (await ws.collection("scheduledPosts").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 300 })).items.filter((x) => x.channel === q.channel && x.scheduledAt && !["cancelled", "failed"].includes(x.status));
  const taken = (t: number) => existing.some((x) => Math.abs(Date.parse(x.scheduledAt!) - t) < 3 * 3_600_000);
  const days = own ? [own.weekday] : h.days;
  const hours = own ? [own.hour] : h.hours;
  const out: { at: string; localTime: string; timezone: string; basis: "your_results" | "general_heuristic"; reason: string }[] = [];
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  for (let i = 0; i < 21 && out.length < q.count; i++) {
    const day = zonedParts(new Date(now + i * DAY_MS), own ? tz : slotTz);
    if (!days.includes(day.weekday)) continue;
    for (const hour of hours) {
      const at = zonedToUtc(day.y, day.m, day.d, hour, hour === 0 && q.channel === "producthunt" ? 1 : 0, own ? tz : slotTz);
      if (at.getTime() < now + 30 * 60_000 || taken(at.getTime())) continue;
      const lp = zonedParts(at, tz);
      out.push({
        at: at.toISOString(),
        localTime: `${dayNames[lp.weekday]} ${String(lp.h).padStart(2, "0")}:${String(lp.min).padStart(2, "0")}`,
        timezone: tz,
        basis: own ? "your_results" : "general_heuristic",
        reason: own
          ? `Your ${q.channel} posts published on ${dayNames[own.weekday]}s averaged ${own.meanViews} platform-reported views (${own.samples} of ${own.totalPosts} posts). This is a correlation in a small sample, not proof that timing caused it.`
          : `${h.why} General starting point — not based on research or your data yet.`,
      });
      if (out.length >= q.count) break;
    }
  }
  return {
    channel: q.channel,
    timezone: tz,
    label: "Suggestions",
    basis: own ? "your_results" : "general_heuristic",
    note: own ? "Based on your own published posts (correlation, not causation)." : "MuseLaunch will tailor suggestions once your posts have platform-reported results.",
    items: out,
  };
}

// ---------------------------------------------------------------------------
// Scheduler tick (wire to Cloud Scheduler → worker; idempotent)
// ---------------------------------------------------------------------------

/**
 * Enqueue `publish.post` for approved API posts whose time has come, across workspaces.
 * Safe to call every minute: job idempotency keys + status guards prevent duplicates.
 */
export async function runDueScheduledPosts(p: Platform, now = Date.now()): Promise<{ workspaces: number; enqueued: number; errors: { workspaceId: string; postId: string; code: string }[] }> {
  let cursor: string | null | undefined;
  let workspaces = 0;
  let enqueued = 0;
  const errors: { workspaceId: string; postId: string; code: string }[] = [];
  const cutoff = new Date(now).toISOString();
  do {
    const page = await p.db.top("workspaces").list({ limit: 100, cursor });
    for (const w of page.items) {
      workspaces++;
      // Expired pending OAuth connections (never finished by the user who started them) are revoked + deleted.
      await purgeExpiredPendingConnections(p, w.id).catch((err) => p.log.warn({ workspaceId: w.id, err: toAppError(err).code }, "pending connection cleanup failed"));
      const due = await p.db.ws(w.id).collection("scheduledPosts").list({ where: [["status", "==", "scheduled"], ["scheduledAt", "<=", cutoff]], orderBy: { field: "scheduledAt", dir: "asc" }, limit: 50 });
      for (const post of due.items) {
        if (post.mode !== "api") continue;
        try {
          await enqueuePublish(p, w.id, post.id, "system", { system: true });
          enqueued++;
        } catch (raw) {
          const err = toAppError(raw);
          errors.push({ workspaceId: w.id, postId: post.id, code: err.code });
          await p.db.ws(w.id).collection("scheduledPosts").update(post.id, { status: err.code === "APPROVAL_REQUIRED" ? "awaiting_approval" : "failed", lastError: `Scheduled publish couldn't start: ${err.toInfo().userMessage ?? err.message}`.slice(0, 2000) }, { actor: "system" });
        }
      }
    }
    cursor = page.nextCursor;
  } while (cursor);
  return { workspaces, enqueued, errors };
}

