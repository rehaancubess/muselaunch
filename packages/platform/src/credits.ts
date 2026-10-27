import { createHash } from "node:crypto";
import { CreditBalance, CreditReservation, DEFAULT_CREDIT_PRICES, DEFAULT_PLANS, type CreditLedgerEntry, type Plan, type PlanId } from "@muselaunch/contracts";
import { nowIso, type Db, type Tx } from "@muselaunch/db";
import type { Config } from "./config";
import { AppError } from "./errors";

export const BALANCE_KEY = "billing.credits";

const hashId = (prefix: string, key: string) => `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, 26)}`;

export type CreditPrices = Record<string, number>;

export function loadPrices(cfg: Pick<Config, "CREDIT_PRICES_JSON">): CreditPrices {
  const base: CreditPrices = { ...DEFAULT_CREDIT_PRICES };
  if (cfg.CREDIT_PRICES_JSON) Object.assign(base, JSON.parse(cfg.CREDIT_PRICES_JSON));
  return base;
}

export function loadPlans(cfg: Pick<Config, "PLANS_JSON">): Record<PlanId, Plan> {
  if (!cfg.PLANS_JSON) return DEFAULT_PLANS;
  return { ...DEFAULT_PLANS, ...(JSON.parse(cfg.PLANS_JSON) as Partial<Record<PlanId, Plan>>) };
}

/** Pure credit estimate for an operation. Shown to users before costly work (spec 4.12). */
export function estimateCredits(prices: CreditPrices, operation: string, params: Record<string, unknown> = {}): { credits: number; breakdown: { label: string; credits: number }[] } {
  const num = (k: string, d: number) => (typeof params[k] === "number" ? (params[k] as number) : d);
  const line = (label: string, credits: number) => ({ credits, breakdown: [{ label, credits }] });
  switch (operation) {
    case "render.final": {
      const blocks = Math.max(1, Math.ceil(num("durationSec", 15) / 15));
      return line(`Final render (${blocks}×15s)`, blocks * (prices["render.final_per_15s"] ?? 8));
    }
    case "media.segment": {
      if (params.mediaType === "image") return line("Image segmentation", prices["media.segment_image"] ?? 3);
      const blocks = Math.max(1, Math.ceil(num("durationSec", 10) / 10));
      return line(`Video segmentation (${blocks}×10s)`, blocks * (prices["media.segment_per_10s"] ?? 12));
    }
    case "media.transcribe": {
      const mins = Math.max(1, Math.ceil(num("durationSec", 60) / 60));
      return line(`Transcription (${mins} min)`, mins * (prices["media.transcribe_per_min"] ?? 1));
    }
    case "media.image_generate": {
      const n = Math.max(1, num("count", 1));
      return line(`Image generation ×${n}`, n * (prices["media.image_generate"] ?? 6));
    }
    case "media.tts": {
      const chars = typeof params.text === "string" ? params.text.length : num("chars", 300);
      return line("Voiceover (external TTS)", Math.max(1, Math.ceil(chars / 100)) * (prices["media.tts_per_100_chars"] ?? 1));
    }
    case "discover.refresh": {
      const n = Math.max(1, Array.isArray(params.trackedCreatorIds) && params.trackedCreatorIds.length ? params.trackedCreatorIds.length : num("trackers", 1));
      return line(`Check ${n} tracked account${n === 1 ? "" : "s"}`, n * (prices["discover.refresh_per_tracker"] ?? 2));
    }
    default: {
      const c = prices[operation] ?? 0;
      return line(operation, c);
    }
  }
}

/**
 * Atomic, idempotent credit ledger (spec 4.12).
 * Balance lives in a single state doc updated in the same transaction as the ledger entry.
 * Ledger entry ids are derived from idempotency keys so retries never double-charge.
 */
export class CreditService {
  readonly prices: CreditPrices;
  readonly plans: Record<PlanId, Plan>;
  constructor(
    private readonly db: Db,
    private readonly cfg: Config,
  ) {
    this.prices = loadPrices(cfg);
    this.plans = loadPlans(cfg);
  }

  estimate(operation: string, params: Record<string, unknown> = {}) {
    return estimateCredits(this.prices, operation, params);
  }

  async balance(workspaceId: string): Promise<CreditBalance> {
    const b = await this.db.ws(workspaceId).state(BALANCE_KEY, CreditBalance).get();
    if (b) return b;
    return this.ensureAccount(workspaceId, { grant: 0, reason: "init" });
  }

  /** Create the balance doc with an initial grant if it does not exist (idempotent). */
  async ensureAccount(workspaceId: string, opts: { grant: number; reason: string; actor?: string }): Promise<CreditBalance> {
    return this.db.runTransaction(async (tx) => {
      const existing = await tx.getState(workspaceId, BALANCE_KEY, CreditBalance);
      if (existing) return existing;
      const now = nowIso();
      const bal: CreditBalance = { workspaceId, available: opts.grant, reserved: 0, lifetimeGranted: opts.grant, lifetimeConsumed: 0, periodStart: now, updatedAt: now };
      tx.setState(workspaceId, BALANCE_KEY, CreditBalance, bal);
      if (opts.grant > 0) {
        this.ledger(tx, workspaceId, "led_grant_initial", { type: "grant", credits: opts.grant, reason: opts.reason, balanceAfter: { available: bal.available, reserved: 0 }, actor: opts.actor ?? "system" });
      }
      return bal;
    });
  }

  async grant(workspaceId: string, credits: number, opts: { reason: string; idempotencyKey: string; actor: string }): Promise<CreditBalance> {
    if (!Number.isInteger(credits) || credits <= 0) throw new AppError("BAD_REQUEST", "credits must be a positive integer");
    await this.balance(workspaceId);
    const ledgerId = hashId("led", `grant:${opts.idempotencyKey}`);
    return this.db.runTransaction(async (tx) => {
      const bal = (await tx.getState(workspaceId, BALANCE_KEY, CreditBalance))!;
      if (await tx.get(workspaceId, "creditLedger", ledgerId)) return bal;
      const next = { ...bal, available: bal.available + credits, lifetimeGranted: bal.lifetimeGranted + credits, updatedAt: nowIso() };
      tx.setState(workspaceId, BALANCE_KEY, CreditBalance, next);
      this.ledger(tx, workspaceId, ledgerId, { type: "grant", credits, reason: opts.reason, balanceAfter: { available: next.available, reserved: next.reserved }, actor: opts.actor });
      return next;
    });
  }

  /** Signed adjustment by an operator (positive or negative). */
  async adjust(workspaceId: string, delta: number, opts: { reason: string; idempotencyKey: string; actor: string }): Promise<CreditBalance> {
    await this.balance(workspaceId);
    const ledgerId = hashId("led", `adjust:${opts.idempotencyKey}`);
    return this.db.runTransaction(async (tx) => {
      const bal = (await tx.getState(workspaceId, BALANCE_KEY, CreditBalance))!;
      if (await tx.get(workspaceId, "creditLedger", ledgerId)) return bal;
      const next = { ...bal, available: bal.available + delta, updatedAt: nowIso() };
      tx.setState(workspaceId, BALANCE_KEY, CreditBalance, next);
      this.ledger(tx, workspaceId, ledgerId, { type: "adjust", credits: Math.abs(delta), reason: `${delta >= 0 ? "+" : "-"} ${opts.reason}`, balanceAfter: { available: next.available, reserved: next.reserved }, actor: opts.actor });
      return next;
    });
  }

  /**
   * Hold credits for a job. Idempotent per `idempotencyKey`: a retried reservation returns the
   * existing open reservation instead of holding twice. Throws INSUFFICIENT_CREDITS.
   */
  async reserve(
    workspaceId: string,
    credits: number,
    opts: { operation: string; idempotencyKey: string; actor: string; jobId?: string; ttlMs?: number },
  ): Promise<{ reservationId: string; credits: number }> {
    if (!Number.isInteger(credits) || credits < 0) throw new AppError("BAD_REQUEST", "credits must be a non-negative integer");
    const reservationId = hashId("rsv", opts.idempotencyKey);
    if (credits === 0) return { reservationId, credits: 0 };
    await this.balance(workspaceId);
    return this.db.runTransaction(async (tx) => {
      const bal = (await tx.getState(workspaceId, BALANCE_KEY, CreditBalance))!;
      const existing = await tx.get(workspaceId, "reservations", reservationId);
      if (existing) return { reservationId, credits: existing.credits };
      if (bal.available < credits) {
        throw new AppError("INSUFFICIENT_CREDITS", `Needs ${credits} credits, ${bal.available} available`, {
          details: { required: credits, available: bal.available, operation: opts.operation },
          userMessage: `This needs ${credits} credits and you have ${bal.available}.`,
        });
      }
      const next = { ...bal, available: bal.available - credits, reserved: bal.reserved + credits, updatedAt: nowIso() };
      tx.setState(workspaceId, BALANCE_KEY, CreditBalance, next);
      tx.create(
        workspaceId,
        "reservations",
        { id: reservationId, credits, operation: opts.operation, jobId: opts.jobId, status: "open", consumed: 0, expiresAt: new Date(Date.now() + (opts.ttlMs ?? 6 * 3600_000)).toISOString() },
        { actor: opts.actor },
      );
      this.ledger(tx, workspaceId, `led_reserve_${reservationId}`, {
        type: "reserve",
        credits,
        reservationId,
        jobId: opts.jobId,
        operation: opts.operation,
        reason: `Reserved for ${opts.operation}`,
        balanceAfter: { available: next.available, reserved: next.reserved },
        actor: opts.actor,
      });
      return { reservationId, credits };
    });
  }

  /** Consume `consumed` credits from a reservation and release the rest. Idempotent. */
  async settle(workspaceId: string, reservationId: string, consumed: number, opts: { actor: string; reason?: string }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const bal = await tx.getState(workspaceId, BALANCE_KEY, CreditBalance);
      const rsv = await tx.get(workspaceId, "reservations", reservationId);
      if (!bal || !rsv || rsv.status !== "open") return;
      const used = Math.max(0, Math.min(Math.floor(consumed), rsv.credits));
      const refund = rsv.credits - used;
      const next = {
        ...bal,
        reserved: Math.max(0, bal.reserved - rsv.credits),
        available: bal.available + refund,
        lifetimeConsumed: bal.lifetimeConsumed + used,
        updatedAt: nowIso(),
      };
      tx.setState(workspaceId, BALANCE_KEY, CreditBalance, next);
      tx.update(workspaceId, "reservations", reservationId, { status: "settled", consumed: used }, { actor: opts.actor });
      const after = { available: next.available, reserved: next.reserved };
      if (used > 0) {
        this.ledger(tx, workspaceId, `led_consume_${reservationId}`, { type: "consume", credits: used, reservationId, jobId: rsv.jobId, operation: rsv.operation, reason: opts.reason ?? `Used for ${rsv.operation}`, balanceAfter: after, actor: opts.actor });
      }
      if (refund > 0) {
        this.ledger(tx, workspaceId, `led_release_${reservationId}`, { type: "release", credits: refund, reservationId, jobId: rsv.jobId, operation: rsv.operation, reason: "Unused reservation returned", balanceAfter: after, actor: opts.actor });
      }
    });
  }

  /** Return the full reservation (failed/cancelled work). Idempotent. */
  async release(workspaceId: string, reservationId: string, opts: { actor: string; reason: string }): Promise<void> {
    await this.db.runTransaction(async (tx) => {
      const bal = await tx.getState(workspaceId, BALANCE_KEY, CreditBalance);
      const rsv = await tx.get(workspaceId, "reservations", reservationId);
      if (!bal || !rsv || rsv.status !== "open") return;
      const next = { ...bal, reserved: Math.max(0, bal.reserved - rsv.credits), available: bal.available + rsv.credits, updatedAt: nowIso() };
      tx.setState(workspaceId, BALANCE_KEY, CreditBalance, next);
      tx.update(workspaceId, "reservations", reservationId, { status: "released" }, { actor: opts.actor });
      this.ledger(tx, workspaceId, `led_release_${reservationId}`, {
        type: "release",
        credits: rsv.credits,
        reservationId,
        jobId: rsv.jobId,
        operation: rsv.operation,
        reason: opts.reason,
        balanceAfter: { available: next.available, reserved: next.reserved },
        actor: opts.actor,
      });
    });
  }

  async recentLedger(workspaceId: string, limit = 50): Promise<CreditLedgerEntry[]> {
    return (await this.db.ws(workspaceId).collection("creditLedger").list({ orderBy: { field: "createdAt", dir: "desc" }, limit })).items;
  }

  private ledger(tx: Tx, workspaceId: string, id: string, entry: Omit<CreditLedgerEntry, "id" | "workspaceId" | "createdAt" | "updatedAt" | "createdBy">) {
    tx.create(workspaceId, "creditLedger", { id, ...entry }, { actor: entry.actor });
  }
}

export { CreditReservation };
