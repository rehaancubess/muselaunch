/**
 * Home's words, as plain functions (tested in home-lines.test.ts; no React, no "@/" imports):
 * the headline ("Your content is ready" + "2 posts to review"), when a post goes out ("Tomorrow at
 * 10:00 AM"), with its stored reason ("Suggested time", "based on your results"), and video lengths.
 * Only what's stored: no time is invented, and a suggestion is always called one.
 */

export type TimeBasis = "your_youtube" | "your_results" | "suggested";

/** The parts of a post Home's headline counts. */
export interface HeadlinePost {
  status: string;
  /** Waiting for someone's OK (a Needs-you publish decision). */
  waiting: boolean;
  /** Muse is changing it right now. */
  changing: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Your content is ready" / "2 posts to review", or the honest variant for what's really there. */
export function homeHeadline(posts: HeadlinePost[], opts: { working?: boolean } = {}): { title: string; sub: string; caughtUp: boolean } {
  const review = posts.filter((p) => p.waiting && !p.changing).length;
  const toPost = posts.filter((p) => p.status === "manual_post_needed" && !p.changing).length;
  const changing = posts.filter((p) => p.changing).length;
  if (!posts.length) {
    return {
      title: "You’re all caught up",
      sub: opts.working ? "Muse is working on your next posts. They show up here for your OK." : "New posts show up here for your OK. Nothing goes out without you.",
      caughtUp: true,
    };
  }
  const parts = [review ? `${plural(review, "post")} to review` : null, toPost ? `${plural(toPost, "post")} ready for you to post` : null, changing ? `${plural(changing, "post")} being changed by Muse` : null].filter(Boolean) as string[];
  if (review || toPost) return { title: "Your content is ready", sub: parts.join(" · "), caughtUp: false };
  if (changing) return { title: "Muse is updating your post", sub: `${parts.join(" · ")}. It comes back here for your OK.`, caughtUp: false };
  // Drafts that can't be approved yet (e.g. a fact to check): say so, don't call them ready.
  return { title: posts.length === 1 ? "A post needs a look" : "Your posts need a look", sub: `${plural(posts.length, "post")} not ready to schedule yet`, caughtUp: false };
}

/** "2026-01-23" for an instant in a time zone. */
function dayKey(ms: number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

function nextDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

const safeTz = (tz?: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz || "UTC" });
    return tz || "UTC";
  } catch {
    return "UTC";
  }
};

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

/**
 * The time line on the next post: "Suggested time: Tomorrow at 10:00 AM", "… · based on your
 * results", "… · based on your YouTube views", a plain time when no reason is stored, or "No time set
 * yet". Never presents a suggestion as research.
 */
export function postTimeLine(p: { scheduledAt?: string; timeBasis?: TimeBasis }, tz?: string, now = Date.now()): string {
  if (!p.scheduledAt) return "No time set yet";
  const when = whenLabel(p.scheduledAt, tz, now);
  if (p.timeBasis === "your_results") return `Suggested time: ${when} · based on your results`;
  if (p.timeBasis === "your_youtube") return `Suggested time: ${when} · based on your YouTube views`;
  if (p.timeBasis === "suggested") return `Suggested time: ${when}`;
  return when;
}

/** "0:20", "1:05" (video length on thumbnails). */
export function clock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
