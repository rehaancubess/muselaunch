import type { Channel } from "@muselaunch/contracts";

/**
 * Step-by-step manual posting instructions per channel. Used whenever API publishing isn't
 * available (not configured, pending review, unsupported channel, or community rules).
 */
const STEPS: Record<Channel, string[]> = {
  instagram: [
    "Download the video/image and the caption from this post (or the export package).",
    "Transfer the file to your phone, open Instagram and tap + → Reel (or Post for images).",
    "Select the file, keep the original aspect ratio, and add the cover frame if you like.",
    "Paste the caption (hashtags included). If the visuals use AI-generated imagery, turn on the AI label under Advanced settings.",
    "Share, open the published post, tap ⋯ → Copy link.",
  ],
  facebook: [
    "Download the video and caption.",
    "Open your Facebook Page (Meta Business Suite) → Create post or Create reel.",
    "Upload the file, paste the caption, and choose Publish now or Schedule.",
    "Open the published post and copy its link.",
  ],
  tiktok: [
    "Download the video and caption to your phone.",
    "Open TikTok → + → Upload, choose the video.",
    "Paste the caption. If the video contains AI-generated content, enable the 'AI-generated content' label in More options.",
    "Choose who can watch, then Post. Open the post → Share → Copy link.",
  ],
  youtube: [
    "Download the video, title, description and tags.",
    "Open YouTube Studio → Create → Upload videos (vertical ≤3 min videos become Shorts).",
    "Paste title, description and tags; answer 'Altered or synthetic content' honestly if AI-generated visuals are used.",
    "Choose visibility (Public / Unlisted / Scheduled) and publish. Copy the video link.",
  ],
  linkedin: [
    "Download the video and the post text.",
    "On LinkedIn click Start a post → Media, upload the video and paste the text.",
    "Post, then open the post's ⋯ menu → Copy link to post.",
  ],
  x: [
    "Download the video/image and the post text (max 280 characters on standard accounts).",
    "On X click Post, attach the media, paste the text and post.",
    "Open the post and copy its link (Share → Copy link).",
  ],
  threads: [
    "Download the media and caption.",
    "Open Threads → New thread, attach the media and paste the text, then Post.",
    "Open the thread → Share → Copy link.",
  ],
  reddit: [
    "MuseLaunch never posts to Reddit or other communities automatically.",
    "Read the subreddit's rules first: many forbid self-promotion or require a specific flair/day.",
    "Post as yourself and disclose that you're the developer. Lead with something useful (story, lesson, demo), not an ad.",
    "Reply to comments personally. Copy the post link afterwards.",
  ],
  producthunt: [
    "Use the export package (gallery images, thumbnail, tagline, description, maker comment).",
    "Schedule the launch on producthunt.com → Submit; launches go live at 12:01 AM Pacific Time.",
    "Post the maker comment right after launch and answer questions throughout the day.",
    "Copy the product page link.",
  ],
  hackernews: [
    "Hacker News is manual only. Read the Show HN guidelines (news.ycombinator.com/showhn.html).",
    "Submit as 'Show HN: <name> – <what it does>' with a link people can try without signing up where possible.",
    "Add a first comment explaining what you built and why; respond to feedback personally.",
    "Copy the item link.",
  ],
  newsletter: ["Copy the text into your newsletter tool, attach or link the media, and send.", "Copy the web version link if your tool provides one."],
  website: ["Add the media and copy to your website or blog post and publish it.", "Copy the page URL."],
  app_store: [
    "Screenshots and app previews are updated in App Store Connect → your app → the version page.",
    "Upload the exported assets in the required sizes, save, and submit for review if needed.",
    "Use your App Store product page URL as the link.",
  ],
  google_play: [
    "Open Play Console → Grow → Store presence → Main store listing.",
    "Upload the exported graphics/video link and save; changes may need review.",
    "Use your Play Store listing URL as the link.",
  ],
  other: ["Download the media and copy, then post it on the destination channel.", "Copy the link of the published post."],
};

const CLOSING = "Back in MuseLaunch, click “Mark as posted” and paste the post link so Insights can attribute its results.";

export function manualInstructions(channel: Channel, reason?: string): string[] {
  return [...(reason ? [`Why manual: ${reason}`] : []), ...STEPS[channel], CLOSING].map((s) => s.slice(0, 500));
}

/** Hosts a confirmed post URL must belong to (prevents mistyped/irrelevant links). */
export const POST_URL_HOSTS: Partial<Record<Channel, string[]>> = {
  instagram: ["instagram.com"],
  facebook: ["facebook.com", "fb.watch", "fb.com"],
  tiktok: ["tiktok.com"],
  youtube: ["youtube.com", "youtu.be"],
  linkedin: ["linkedin.com", "lnkd.in"],
  x: ["x.com", "twitter.com"],
  threads: ["threads.net", "threads.com"],
  reddit: ["reddit.com", "redd.it"],
  producthunt: ["producthunt.com"],
  hackernews: ["news.ycombinator.com"],
  app_store: ["apps.apple.com"],
  google_play: ["play.google.com"],
};
