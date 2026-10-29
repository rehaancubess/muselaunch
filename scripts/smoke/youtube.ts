import { computeChannelStats, normalizeVideos } from "@muselaunch/analytics";
import type { Platform } from "@muselaunch/platform";
import { parseYouTubeChannelInput, YouTubeDataClient } from "@muselaunch/providers";
import { saveLive } from "./_save";

/**
 * YouTube Data API v3 live check (module F): channels.list → playlistItems.list → videos.list for one
 * public channel (3 quota units of the project's 10,000/day). Skips when YOUTUBE_API_KEY isn't set.
 * YOUTUBE_SMOKE_CHANNEL picks the channel (default @GoogleDevelopers). Redacted responses go to
 * fixtures/live/ so the parsers can be checked against the real shapes.
 */
export async function run(p: Platform): Promise<string> {
  const apiKey = p.cfg.YOUTUBE_API_KEY;
  if (!apiKey) return "SKIPPED: set YOUTUBE_API_KEY (setup-youtube.cmd creates one restricted to YouTube Data API v3) to run";
  const input = process.env.YOUTUBE_SMOKE_CHANNEL?.trim() || "@GoogleDevelopers";
  const ref = parseYouTubeChannelInput(input);
  if (ref.kind === "video") return "SKIPPED: YOUTUBE_SMOKE_CHANNEL must be a channel, not a video";
  let units = 0;
  const yt = new YouTubeDataClient({
    apiKey,
    onCall: (c) => {
      units += c.units;
    },
  });
  const channel = await yt.channel(ref);
  if (!channel) return `channel ${input} not found (channels.list returned no items)`;
  saveLive("youtube-channels", channel);
  const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
  const ids = uploads ? (await yt.playlistVideos(uploads, 10)).map((x) => x.videoId) : [];
  const items = await yt.videos(ids);
  saveLive("youtube-videos", items);
  const now = Date.now();
  const { videos, excluded } = normalizeVideos(items, ids, now);
  const stats = computeChannelStats(videos, excluded, new Date(now).toISOString());
  return `${channel.snippet?.title ?? channel.id} (${channel.id}): ${stats.videosAnalyzed} of ${ids.length} recent uploads analysed, median views ${stats.medians.views ?? "n/a"}, length groups ${stats.byLength.map((g) => `${g.key.split(":")[1]}=${g.videos}`).join(" ")} | ${units} quota units`;
}
