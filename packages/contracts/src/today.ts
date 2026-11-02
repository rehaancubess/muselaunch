import { z } from "zod";
import { Channel, Id, IsoDateTime } from "./common";
import { PostTimeBasis } from "./always-on";
import { NeedsYouItem } from "./autopilot";
import { PostChange, PostStatus } from "./publishing";

/**
 * Creator → Today (GET /apps/:appId/today): the posts waiting on the person (the next one big, the
 * others as "Then:"), every other decision waiting in Needs you, and the newest finished videos.
 * Built from stored records only: times keep their stored reason ("suggested time" is never shown as
 * research), a channel that isn't connected says so, and the publish decision is the same Needs-you
 * item (same route, permission and snapshot).
 */
export const TodayPost = z.object({
  id: Id,
  channel: Channel,
  /** `api`: MuseLaunch posts it through a connected account; `manual`: the person posts it. */
  mode: z.enum(["api", "manual"]),
  status: PostStatus,
  title: z.string().max(300).optional(),
  /** The caption with its link filled in (what gets posted / copied). */
  caption: z.string().max(5000),
  /** Title, caption and tracked link, ready to paste where the person posts it themselves. */
  copyText: z.string().max(6000),
  scheduledAt: IsoDateTime.optional(),
  timezone: z.string().max(64),
  /** Where the time comes from, in plain words (absent: no stored reason). */
  timeBasis: PostTimeBasis.optional(),
  timeReason: z.string().max(500).optional(),
  /** The connected account it goes out through (api), or why the person posts it (manual). */
  account: z.object({ name: z.string().max(200), status: z.string().max(40) }).nullable(),
  manualReason: z.string().max(500).optional(),
  video: z
    .object({
      assetId: Id,
      posterAssetId: Id.optional(),
      kind: z.enum(["video", "image"]),
      durationSec: z.number().nonnegative().optional(),
      width: z.number().int().positive().optional(),
      height: z.number().int().positive().optional(),
    })
    .nullable(),
  compositionId: Id.optional(),
  compositionTitle: z.string().max(200).optional(),
  compositionVersion: z.number().int().optional(),
  /** The publish decision (same item as Needs you), when it's waiting for one. */
  decision: NeedsYouItem.nullable(),
  /** What still stops approval (e.g. the fact check), in plain words. */
  blocked: z.string().max(2000).optional(),
  change: PostChange.nullable(),
  /** The caller may ask Muse to change it (content.write, and the post isn't out yet). */
  canChange: z.boolean(),
});
export type TodayPost = z.infer<typeof TodayPost>;

export const TodayVideo = z.object({
  compositionId: Id,
  title: z.string().max(200),
  version: z.number().int(),
  assetId: Id,
  posterAssetId: Id.optional(),
  durationSec: z.number().nonnegative().optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  renderedAt: IsoDateTime,
});
export type TodayVideo = z.infer<typeof TodayVideo>;

export const TodayResponse = z.object({
  appId: Id,
  /** Waiting for approval first (in the order they'd go out), then ready for you to post, then posts Muse is changing. */
  posts: z.array(TodayPost),
  /** Every other Needs-you item for this app (decisions, suggestions, spend, checks). */
  needs: z.array(NeedsYouItem),
  /** Newest finished video per composition (final renders only). */
  videos: z.array(TodayVideo),
});
export type TodayResponse = z.infer<typeof TodayResponse>;
