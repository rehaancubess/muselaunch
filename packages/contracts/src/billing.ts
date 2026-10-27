import { z } from "zod";
import { Actor, BaseEntity, Id, IsoDateTime } from "./common";

export const PlanId = z.enum(["free", "starter", "growth", "studio"]);
export type PlanId = z.infer<typeof PlanId>;

export const Plan = z.object({
  id: PlanId,
  name: z.string(),
  monthlyCredits: z.number().int().nonnegative(),
  /** Display only; actual prices come from the configured payment provider. */
  displayPrice: z.string().optional(),
  limits: z.object({
    apps: z.number().int().positive(),
    members: z.number().int().positive(),
    concurrentJobs: z.number().int().positive(),
    maxVideoSec: z.number().int().positive(),
    finalRendersPerDay: z.number().int().positive(),
    researchRunsPerDay: z.number().int().positive(),
  }),
});
export type Plan = z.infer<typeof Plan>;

/** Defaults; override via `PLANS_JSON` env. Not hard-coded business assumptions. */
export const DEFAULT_PLANS: Record<PlanId, Plan> = {
  free: {
    id: "free",
    name: "Free beta",
    monthlyCredits: 300,
    limits: { apps: 2, members: 2, concurrentJobs: 2, maxVideoSec: 30, finalRendersPerDay: 5, researchRunsPerDay: 3 },
  },
  starter: {
    id: "starter",
    name: "Starter",
    monthlyCredits: 1500,
    limits: { apps: 3, members: 3, concurrentJobs: 3, maxVideoSec: 60, finalRendersPerDay: 25, researchRunsPerDay: 10 },
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyCredits: 5000,
    limits: { apps: 10, members: 8, concurrentJobs: 5, maxVideoSec: 90, finalRendersPerDay: 100, researchRunsPerDay: 30 },
  },
  studio: {
    id: "studio",
    name: "Studio",
    monthlyCredits: 15000,
    limits: { apps: 50, members: 25, concurrentJobs: 10, maxVideoSec: 180, finalRendersPerDay: 400, researchRunsPerDay: 100 },
  },
};

export const Subscription = BaseEntity.extend({
  planId: PlanId,
  status: z.enum(["trialing", "active", "past_due", "canceled", "none"]),
  provider: z.enum(["none", "stripe", "razorpay", "lemonsqueezy", "manual"]),
  externalId: z.string().max(200).optional(),
  currentPeriodStart: IsoDateTime,
  currentPeriodEnd: IsoDateTime,
});
export type Subscription = z.infer<typeof Subscription>;

export const LedgerType = z.enum(["grant", "reserve", "consume", "release", "refund", "adjust", "expire"]);
export type LedgerType = z.infer<typeof LedgerType>;

/**
 * Append-only credit ledger. Document id = idempotency key, so retries of the same
 * operation are no-ops. `credits` is always a positive magnitude; `type` gives direction.
 */
export const CreditLedgerEntry = BaseEntity.extend({
  type: LedgerType,
  credits: z.number().int().nonnegative(),
  /** For consume/release: the reservation being settled. For reserve: its own id. */
  reservationId: Id.optional(),
  jobId: Id.optional(),
  operation: z.string().max(80).optional(),
  reason: z.string().max(300),
  balanceAfter: z.object({ available: z.number().int(), reserved: z.number().int() }),
  actor: Actor,
});
export type CreditLedgerEntry = z.infer<typeof CreditLedgerEntry>;

/** `workspaces/{wid}/billing/credits` singleton. */
export const CreditBalance = z.object({
  workspaceId: Id,
  available: z.number().int(),
  reserved: z.number().int().nonnegative(),
  lifetimeGranted: z.number().int().nonnegative(),
  lifetimeConsumed: z.number().int().nonnegative(),
  periodStart: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type CreditBalance = z.infer<typeof CreditBalance>;

/** Open reservation state, `workspaces/{wid}/reservations/{reservationId}`. */
export const CreditReservation = BaseEntity.extend({
  credits: z.number().int().positive(),
  operation: z.string().max(80),
  jobId: Id.optional(),
  status: z.enum(["open", "settled", "released"]),
  consumed: z.number().int().nonnegative().default(0),
  expiresAt: IsoDateTime,
});
export type CreditReservation = z.infer<typeof CreditReservation>;

/**
 * Credit price list per billable operation (1 credit ≈ $0.01 of blended provider cost + margin).
 * Values can be overridden via `CREDIT_PRICES_JSON`.
 */
export const DEFAULT_CREDIT_PRICES = {
  "app.import": 2,
  "app.analyze": 15,
  "research.run": 40,
  "strategy.run": 30,
  "campaign.generate_concepts": 15,
  "storyboard.generate": 8,
  "composition.build": 2,
  "composition.edit": 3,
  "copy.generate": 4,
  "render.preview": 3,
  /** Per started 15 seconds of final video. */
  "render.final_per_15s": 8,
  /** Per started 10 seconds of footage segmented. */
  "media.segment_per_10s": 12,
  "media.segment_image": 3,
  /** Per started minute of audio. */
  "media.transcribe_per_min": 1,
  "media.image_generate": 6,
  "media.image_edit": 6,
  "media.tts_per_100_chars": 1,
  "experiment.analyze": 8,
  "outreach.draft": 3,
  "memory.retrieve": 0,
} as const;
export type CreditOperation = keyof typeof DEFAULT_CREDIT_PRICES;
