/**
 * Home's words, as plain functions (ported from apps/web/src/features/today/home-lines.ts and
 * next-post.tsx; tested in home-lines.test.ts): the headline ("Your content is ready" + "2 posts to
 * review"), when a post goes out ("Tomorrow at 10:00 AM") with its stored reason ("Suggested time"),
 * and where a post stands. Only what's stored: no time is invented, and a suggestion is called one.
 */
import { isPostChangeRunning, type Channel, type TimeBasis, type TodayPost } from "../api/types";

export interface HeadlinePost {
  status: string;
  /** Waiting for someone's OK (a publish decision). */
  waiting: boolean;
  /** Muse is changing it right now. */
  changing: boolean;
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Your content is ready" / "2 posts to review", or the honest variant for what's really there. */
export function homeHeadline(posts: HeadlinePost[]): { title: string; sub: string; caughtUp: boolean } {
  const review = posts.filter((p) => p.waiting && !p.changing).length;
  const toPost = posts.filter((p) => p.status === "manual_post_needed" && !p.changing).length;
  const changing = posts.filter((p) => p.changing).length;
  if (!posts.length) return { title: "You’re all caught up", sub: "New posts show up here for your OK. Nothing goes out without you.", caughtUp: true };
  const parts = [review ? `${plural(review, "post")} to review` : null, toPost ? `${plural(toPost, "post")} ready for you to post` : null, changing ? `${plural(changing, "post")} being changed by Muse` : null].filter(Boolean) as string[];
  if (review || toPost) return { title: "Your content is ready", sub: parts.join(" · "), caughtUp: false };
  if (changing) return { title: "Muse is updating your post", sub: `${parts.join(" · ")}. It comes back here for your OK.`, caughtUp: false };
  return { title: posts.length === 1 ? "A post needs a look" : "Your posts need a look", sub: `${plural(posts.length, "post")} not ready to schedule yet`, caughtUp: false };
}

export const headlineOf = (posts: TodayPost[]) => homeHeadline(posts.map((p) => ({ status: p.status, waiting: Boolean(p.decision), changing: isPostChangeRunning(p.change) })));

function safeTz(tz?: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC" });
    return tz || "UTC";
  } catch {
    return "UTC";
  }
}

/** "2026-01-23" for an instant in a time zone. */
function dayKey(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** "Today at 7:00 PM", "Tomorrow at 10:00 AM", "Thu, Jan 23 at 10:00 AM" in the workspace's time zone. */
export function whenLabel(iso: string, tz?: string, now = Date.now()): string {
  const zone = safeTz(tz);
  const at = Date.parse(iso);
  const time = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone });
  const day = dayKey(at, zone);
  const today = dayKey(now, zone);
  if (day === today) return `Today at ${time}`;
  if (day === nextDayKey(today)) return `Tomorrow at ${time}`;
  const date = new Date(at).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: zone, ...(day.slice(0, 4) !== today.slice(0, 4) ? { year: "numeric" } : {}) });
  return `${date} at ${time}`;
}

/** The same time inside a sentence: "tomorrow at 10:00 AM", "on Thu, Jan 23 at 10:00 AM". */
export function whenInSentence(iso: string, tz?: string, now = Date.now()): string {
  const w = whenLabel(iso, tz, now);
  return /^(Today|Tomorrow) /.test(w) ? w.charAt(0).toLowerCase() + w.slice(1) : `on ${w}`;
}

/** "Jan 23, 10:00 AM" (Coming up). */
export function shortWhen(iso: string, tz?: string): string {
  const zone = safeTz(tz);
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: zone })}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: zone })}`;
}

/** "Suggested time: Tomorrow at 10:00 AM" (+ "· based on your results"), a plain time, or "No time set yet". */
export function postTimeLine(p: { scheduledAt?: string; timeBasis?: TimeBasis }, tz?: string, now = Date.now()): string {
  if (!p.scheduledAt) return "No time set yet";
  const when = whenLabel(p.scheduledAt, tz, now);
  if (p.timeBasis === "your_results") return `Suggested time: ${when} · based on your results`;
  if (p.timeBasis === "your_youtube") return `Suggested time: ${when} · based on your YouTube views`;
  if (p.timeBasis === "suggested") return `Suggested time: ${when}`;
  return when;
}

/** "0:20", "1:05". */
export function clock(sec: number | null | undefined): string {
  const s = Math.max(0, Math.round(sec ?? 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The post's name: its title, its video's title, or its caption's first line. */
export function postTitle(post: Pick<TodayPost, "title" | "compositionTitle" | "caption">): string {
  return post.title?.trim() || post.compositionTitle?.trim() || post.caption.split("\n")[0]?.trim() || "Your next post";
}

/** The caption under the title (without its first line when that line is the title). */
export function postBody(post: Pick<TodayPost, "title" | "compositionTitle" | "caption">): string {
  return post.title?.trim() || post.compositionTitle?.trim() ? post.caption : post.caption.split("\n").slice(1).join("\n").trim();
}

export type Tone = "accent" | "warning" | "neutral";

/** Where the post stands, in a few words (when it isn't simply waiting for the person's OK). */
export function postState(post: TodayPost): { text: string; tone: Tone } | null {
  if (isPostChangeRunning(post.change)) return { text: "Muse is changing this post", tone: "accent" };
  if (post.decision) return post.decision.stale ? { text: "Changed since you were asked", tone: "warning" } : !post.decision.canDecide ? { text: "Waiting for approval", tone: "neutral" } : null;
  if (post.status === "manual_post_needed") return { text: "Ready for you to post", tone: "accent" };
  return { text: post.blocked ? "Not ready yet" : "Draft", tone: "neutral" };
}

/** One word or two for a Coming up row. */
export function rowState(post: TodayPost): string {
  if (isPostChangeRunning(post.change)) return "Muse is changing it";
  if (post.decision) return post.decision.stale ? "Changed since you were asked" : "Waiting for your OK";
  if (post.status === "manual_post_needed") return "Ready for you to post";
  return post.blocked ? "Not ready yet" : "Draft";
}

/** Can Schedule post be pressed (the same rule as the web's next post)? */
export const canSchedule = (post: TodayPost) => Boolean(post.decision && post.decision.canDecide && post.decision.approve && !post.decision.stale && !isPostChangeRunning(post.change));

const WHO: Record<string, string> = {
  publish: "someone who can publish",
  "content.approve": "an owner or admin",
  "content.write": "an editor, admin or owner",
};
export const whoCanDecide = (cap: string) => WHO[cap] ?? "someone with permission";

export const CHANNEL_LABEL: Record<Channel, string> = {
  instagram: "Instagram",
  facebook: "Facebook",
  tiktok: "TikTok",
  youtube: "YouTube",
  linkedin: "LinkedIn",
  x: "X",
  threads: "Threads",
  reddit: "Reddit",
  producthunt: "Product Hunt",
  hackernews: "Hacker News",
  newsletter: "Newsletter",
  website: "Website",
  app_store: "App Store",
  google_play: "Google Play",
  other: "Other",
};
export const channelLabel = (c: string) => CHANNEL_LABEL[c as Channel] ?? c;
