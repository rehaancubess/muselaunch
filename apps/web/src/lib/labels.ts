import { humanizeStatus } from "@muselaunch/ui";
import type { AngleType, CampaignGoal, Channel, DeliverableKind, MediaRole } from "@muselaunch/contracts";

/** Campaign status as people read it ("review" means the videos are produced and waiting for the founder). */
export function campaignStatusLabel(status: string): string {
  if (status === "review") return "Ready to review";
  if (status === "producing") return "Producing";
  return humanizeStatus(status);
}

export const GOAL_LABEL: Record<CampaignGoal, string> = {
  awareness: "Awareness",
  launch: "Launch",
  installs: "Installs",
  subscriptions: "Subscriptions",
  feature_announcement: "Feature announcement",
  engagement: "Engagement",
  retention: "Retention",
  community: "Community",
  other: "Other",
};

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

export const DELIVERABLE_LABEL: Record<DeliverableKind, string> = {
  short_video: "Short video",
  app_demo: "App demo",
  feature_promo: "Feature promo",
  launch_announcement: "Launch announcement",
  app_trailer: "App trailer",
  screenshot_graphic: "Screenshot graphic",
  carousel: "Carousel",
  static_ad: "Static ad",
  thumbnail: "Thumbnail",
  product_hunt_assets: "Product Hunt assets",
  caption_pack: "Captions",
  outreach_pack: "Creator outreach",
};

export const ANGLE_LABEL: Record<AngleType, string> = {
  emotional_problem: "Emotional problem",
  practical_demo: "Practical demo",
  founder_story: "Founder story",
  comparison: "Comparison",
  tutorial: "Tutorial",
  social_proof: "Social proof",
  launch_hype: "Launch hype",
  behind_the_scenes: "Behind the scenes",
  other: "Other angle",
};

export const ROLE_LABEL: Record<MediaRole, string> = {
  screenshot: "Screenshot",
  app_recording: "App recording",
  founder_clip: "Founder clip",
  logo: "Logo",
  icon: "Icon",
  product_photo: "Product photo",
  generated_image: "Generated image",
  stock_video: "Stock video",
  stock_image: "Stock image",
  music: "Music",
  voiceover: "Voiceover",
  tts: "Narration (TTS)",
  render: "Render",
  preview: "Preview",
  thumbnail: "Thumbnail",
  mask: "Mask",
  srt: "Captions file",
  package: "Export package",
  document: "Document",
  other: "Other",
};

export function relativeTime(iso?: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(t).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
}

export function formatBytes(n: number): string {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export function formatDuration(sec?: number): string {
  if (sec == null) return "";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
