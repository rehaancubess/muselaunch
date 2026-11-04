import { z } from "zod";
import { Actor, Channel, Id, IsoDateTime, SourceRef } from "./common";

/**
 * "Always on": Growth Autopilot keeps going for an app at a posting pace the plan allows. It keeps
 * about a week of posts ready (each still needs the publish approval), researches on its own every
 * week (Muse Wonder, every finding sourced) and sums up the week. Off by default.
 *
 * Paces: once a week, 3 times a week, 5 times a week, every day. A plan allows up to
 * `Plan.limits.postsPerWeek`; a pace above that is refused, and a downgrade clamps it.
 */
export const ALWAYS_ON_PACES = [1, 3, 5, 7] as const;
export const AlwaysOnPace = z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]);
export type AlwaysOnPace = z.infer<typeof AlwaysOnPace>;

/** Per-app setting (`apps.alwaysOn`). Absent = off. */
export const AppAlwaysOn = z.object({
  enabled: z.boolean().default(false),
  postsPerWeek: AlwaysOnPace.default(1),
  /** Email the weekly summary from the workspace's connected Gmail to that same address. Off by default. */
  emailSummary: z.boolean().default(false),
  /** Who last changed it (always-on work runs on their behalf; they need content.write). */
  updatedBy: Actor.optional(),
  updatedAt: IsoDateTime.optional(),
});
export type AppAlwaysOn = z.infer<typeof AppAlwaysOn>;

/** `PUT /apps/:appId/always-on`: change any of the three; the pace is checked against the plan. */
export const UpdateAlwaysOnRequest = z
  .object({ enabled: z.boolean().optional(), postsPerWeek: AlwaysOnPace.optional(), emailSummary: z.boolean().optional() })
  .refine((v) => v.enabled !== undefined || v.postsPerWeek !== undefined || v.emailSummary !== undefined, { message: "Nothing to change" });
export type UpdateAlwaysOnRequest = z.infer<typeof UpdateAlwaysOnRequest>;

/** Where a post's suggested time comes from (always labelled). */
export const PostTimeBasis = z.enum(["your_youtube", "your_results", "suggested"]);
export type PostTimeBasis = z.infer<typeof PostTimeBasis>;

export const AlwaysOnPaceOption = z.object({
  postsPerWeek: AlwaysOnPace,
  label: z.string().max(40),
  allowed: z.boolean(),
  /** The cheapest plan that allows this pace (shown on options above the current plan). */
  minPlan: z.object({ id: z.string(), name: z.string() }).optional(),
  /** Most this pace spends in a week (videos at the longest length, plus the weekly research). */
  weeklyCredits: z.number().int().nonnegative(),
});
export type AlwaysOnPaceOption = z.infer<typeof AlwaysOnPaceOption>;

export const AlwaysOnPostLine = z.object({
  postId: Id,
  channel: Channel,
  title: z.string().max(300),
  at: IsoDateTime.optional(),
  status: z.string().max(40),
  /** Only for queued posts: how the time was picked, in plain words. */
  timeBasis: PostTimeBasis.optional(),
  timeReason: z.string().max(500).optional(),
  url: z.string().max(2048).optional(),
});
export type AlwaysOnPostLine = z.infer<typeof AlwaysOnPostLine>;

/** The last 7 days and the week ahead, from stored records only (nothing estimated). */
export const AlwaysOnWeeklySummary = z.object({
  from: IsoDateTime,
  to: IsoDateTime,
  posted: z.array(AlwaysOnPostLine),
  queued: z.array(AlwaysOnPostLine),
  research: z.object({
    runId: Id.optional(),
    at: IsoDateTime.optional(),
    status: z.string().max(40).optional(),
    findings: z.number().int().nonnegative(),
    top: z.array(z.object({ id: Id, kind: z.string().max(40), statement: z.string().max(1500), sources: z.array(SourceRef).max(3) })).max(3),
  }),
  suggestions: z.array(z.object({ approvalId: Id, title: z.string().max(300), status: z.string().max(40) })).max(10),
  needsYou: z.number().int().nonnegative(),
  credits: z.object({ used: z.number().int().nonnegative(), allowance: z.number().int().nonnegative() }),
});
export type AlwaysOnWeeklySummary = z.infer<typeof AlwaysOnWeeklySummary>;

/** `GET /apps/:appId/always-on`. */
export const AlwaysOnStatus = z.object({
  appId: Id,
  /** Effective settings (pace already clamped to the plan). */
  settings: AppAlwaysOn,
  /** The pace the person chose, when the plan made it lower (downgrade). */
  requestedPostsPerWeek: z.number().int().optional(),
  plan: z.object({ id: z.string(), name: z.string(), postsPerWeek: z.number().int(), monthlyCredits: z.number().int().nonnegative() }),
  options: z.array(AlwaysOnPaceOption),
  estimate: z.object({
    /** Most one video costs (research shared, fixes included, longest length). */
    perVideo: z.number().int().nonnegative(),
    /** The weekly research sweep (Muse Wonder). */
    sweep: z.number().int().nonnegative(),
    /** Weekly allowance at the effective pace: Always on never spends more in 7 days without asking. */
    weeklyCredits: z.number().int().nonnegative(),
    /** weeklyCredits × 30 / 7, rounded. */
    monthlyCredits: z.number().int().nonnegative(),
    /** Does the plan's monthly credit grant cover it? */
    fitsPlan: z.boolean(),
  }),
  available: z.number().int(),
  week: z.object({ used: z.number().int().nonnegative(), allowance: z.number().int().nonnegative() }),
  loop: z.object({ id: Id, status: z.string().max(40), stage: z.string().max(40), iteration: z.number().int() }).nullable(),
  /** The next post in the queue (approved or waiting for approval), with how its time was picked. */
  next: AlwaysOnPostLine.nullable(),
  queue: z.object({ upcoming: z.number().int().nonnegative(), approved: z.number().int().nonnegative(), awaitingApproval: z.number().int().nonnegative(), target: z.number().int().nonnegative() }),
  sweep: z.object({ lastAt: IsoDateTime.optional(), runId: Id.optional(), status: z.string().max(40).optional(), nextAt: IsoDateTime.optional(), note: z.string().max(300).optional() }),
  gmail: z.object({ connected: z.boolean(), address: z.string().max(200).optional(), lastSentAt: IsoDateTime.optional(), lastError: z.string().max(300).optional() }),
  /** Plain-language notes (e.g. "Your plan now allows 3 posts a week, so the pace went down from 5"). */
  notes: z.array(z.string().max(300)).max(10),
  summary: AlwaysOnWeeklySummary,
});
export type AlwaysOnStatus = z.infer<typeof AlwaysOnStatus>;
