/**
 * Posting a video yourself from the phone (the share sheet): which posts can be shared, the file name
 * the video gets, what the caption step says, and whether a pasted link is the right site for
 * "Did you post it?" (the same hosts the API checks in packages/growth/src/publishing/manual.ts).
 */
import type { Channel, TodayPost } from "../api/types";
import { channelLabel } from "./home-lines";

const POST_URL_HOSTS: Partial<Record<Channel, string[]>> = {
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.watch", "fb.com"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
  linkedin: ["linkedin.com", "lnkd.in"],
  x: ["x.com", "twitter.com"],
  threads: ["threads.net", "threads.com"],
  reddit: ["reddit.com", "redd.it"],
};

export type ShareMode =
  /** Approved for posting yourself: share it, then "Did you post it?" counts it in Results. */
  | "manual"
  /** Approved to go out through a connected account: sharing it elsewhere is fine, but it isn't marked as posted here. */
  | "scheduled"
  | null;

/** Only approved posts can be shared (nothing goes out without the person's OK). */
export function shareMode(post: Pick<TodayPost, "status" | "video">): ShareMode {
  if (!post.video) return null;
  if (post.status === "manual_post_needed") return "manual";
  if (post.status === "scheduled") return "scheduled";
  return null;
}

/** "Share to Instagram…" for the post's own channel; "Share…" otherwise. */
export function shareLabel(channel: string): string {
  return channel === "instagram" || channel === "tiktok" || channel === "youtube" ? `Share to ${channelLabel(channel)}…` : "Share…";
}

/** A tidy file name for the downloaded video ("one-tap-to-deep-work.mp4"). */
export function videoFileName(title: string, id: string, ext = "mp4"): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "muselaunch-video"}-${id.slice(-6).toLowerCase()}.${ext}`;
}

/** "Caption copied — paste it in Instagram". */
export const copiedLine = (channel: string) => `Caption copied — paste it in ${channelLabel(channel)}`;

/** Is this pasted link a post on the post's site? null = fine; else what to say. */
export function postLinkProblem(channel: string, url: string): string | null {
  const t = url.trim();
  if (!/^https?:\/\/\S+$/i.test(t)) return "Paste the full link, starting with https://";
  const host = (/^https?:\/\/([^/?#:]+)/i.exec(t)?.[1] ?? "").toLowerCase();
  const hosts = POST_URL_HOSTS[channel as Channel];
  const name = channelLabel(channel);
  if (hosts && !hosts.some((h) => host === h || host.endsWith(`.${h}`))) return `That isn’t ${/^[AEIOU]/.test(name) ? "an" : "a"} ${name} link. Paste the link of the ${name} post.`;
  return null;
}
