import type { AspectRatio, StockItem, StockProviderId } from "@muselaunch/contracts";
import { AppError, type Platform } from "@muselaunch/platform";
import type { CallContext } from "../meta/client";
import { searchStock, STOCK_ADAPTERS, type StockDeps } from "./index";

/**
 * Choosing lifestyle b-roll for a storyboard scene: search every configured provider that has the
 * kind, then rank by relevance to the query, orientation that matches the video's aspect ratio,
 * length ≥ the scene (video) and usable resolution. Pure ranking (`rankStock`) is separate from the
 * metered searches (`findStock`) so it can be tested without network.
 */

export type StockOrientation = "portrait" | "landscape" | "square";

export function orientationFor(aspect: AspectRatio): StockOrientation {
  return aspect === "16:9" ? "landscape" : aspect === "1:1" ? "square" : "portrait";
}

/** Stable identity of a provider item (dedupe within a storyboard). */
export const stockKey = (item: Pick<StockItem, "provider" | "kind" | "id">) => `${item.provider}:${item.kind}:${item.id}`;

const STOP = new Set(
  "a an and are as at be by for from in into is it its of on or over the their this to under up with without while near very some soft warm cool cozy calm bright light dark shot close closeup close-up view footage video photo image stock b-roll broll scene background".split(" "),
);

/** Lower-cased content words (stop words and very short tokens dropped, naive plural folding). */
export function queryTerms(q: string): string[] {
  const words = q
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return [...new Set(words)];
}

/** Shorter fallbacks for providers whose search is strict on long natural-language queries. */
export function simplerQueries(q: string): string[] {
  const terms = queryTerms(q);
  const out: string[] = [];
  if (terms.length >= 3) out.push(terms.slice(0, 3).join(" "));
  if (terms.length > 1) out.push(terms.slice(0, 2).join(" "));
  return out.filter((x) => x && x !== q.trim().toLowerCase());
}

/** Words describing an item: its title/tags plus the slug of its page URL. */
function itemWords(item: StockItem): Set<string> {
  let slug = "";
  try {
    slug = new URL(item.pageUrl).pathname.replace(/\d+/g, " ");
  } catch {
    /* invalid URL: title only */
  }
  return new Set(queryTerms(`${item.title ?? ""} ${slug}`));
}

export interface StockPickInput {
  query: string;
  kind: "image" | "video";
  orientation: StockOrientation;
  /** Scene length: clips at least this long are preferred. */
  minDurationSec?: number;
}

export interface RankedStock {
  item: StockItem;
  score: number;
  /** Position in its provider's own relevance order (0 = provider's best). */
  providerRank: number;
}

function orientationOf(item: StockItem): StockOrientation | undefined {
  if (!item.width || !item.height) return undefined;
  const r = item.width / item.height;
  return r > 1.15 ? "landscape" : r < 0.87 ? "portrait" : "square";
}

/** Score one item (higher is better; ~0..1). */
export function scoreStockItem(item: StockItem, input: StockPickInput, providerRank: number, providerCount: number): number {
  const terms = queryTerms(input.query);
  const words = itemWords(item);
  const hits = terms.filter((t) => words.has(t)).length;
  // Providers already rank by relevance; their order is the main relevance signal when titles are sparse.
  const relevance = (terms.length ? hits / terms.length : 0) * 0.3 + (1 - Math.min(providerRank, providerCount) / Math.max(1, providerCount)) * 0.25;
  const o = orientationOf(item);
  const orientation = !o ? 0.05 : o === input.orientation ? 0.25 : o === "square" || input.orientation === "square" ? 0.1 : 0;
  let duration = 0;
  if (input.kind === "video") {
    const need = input.minDurationSec ?? 0;
    const have = item.durationSec ?? 0;
    duration = !need ? 0.15 : have >= need ? 0.15 : have >= need * 0.6 ? 0.05 : -0.15;
  }
  const short = item.width && item.height ? Math.min(item.width, item.height) : 0;
  const resolution = !short ? 0 : short >= 1080 ? 0.05 : short >= 720 ? 0.03 : short < 400 ? -0.2 : 0;
  return Math.round((relevance + orientation + duration + resolution) * 1000) / 1000;
}

/** Rank candidates from one or more providers (each list in its provider's own order). */
export function rankStock(lists: StockItem[][], input: StockPickInput): RankedStock[] {
  const out: RankedStock[] = [];
  const seen = new Set<string>();
  for (const items of lists) {
    items.forEach((item, i) => {
      const k = stockKey(item);
      if (seen.has(k) || item.kind !== input.kind) return;
      seen.add(k);
      out.push({ item, providerRank: i, score: scoreStockItem(item, input, i, items.length) });
    });
  }
  return out.sort((a, b) => b.score - a.score || a.providerRank - b.providerRank);
}

/** Providers that can serve this kind on this deployment, best first (Pexels → Pixabay → Openverse). */
export function stockProvidersFor(p: Platform, kind: "image" | "video"): StockProviderId[] {
  const order: StockProviderId[] = ["pexels", "pixabay", "openverse"];
  return order.filter((id) => STOCK_ADAPTERS[id].configured(p) && STOCK_ADAPTERS[id].supports(kind));
}

export interface FindStockResult {
  candidates: RankedStock[];
  /** Providers searched (in order). */
  searched: StockProviderId[];
  /** Providers whose search failed (others may still have results). */
  errors: { provider: StockProviderId; code: string; message: string }[];
}

/**
 * Search every configured provider for the kind (metered zero-cost `stock` usage events), retrying
 * with shorter keyword queries when a provider returns nothing, and rank the union. Throws
 * PROVIDER_NOT_CONFIGURED when no provider serves the kind; per-provider failures are returned, not
 * thrown, unless every provider failed.
 */
export async function findStock(p: Platform, ctx: CallContext, input: StockPickInput & { perPage?: number }, deps: StockDeps = {}): Promise<FindStockResult> {
  const providers = stockProvidersFor(p, input.kind);
  if (!providers.length) {
    throw new AppError("PROVIDER_NOT_CONFIGURED", `No stock provider configured for ${input.kind}`, {
      userMessage: input.kind === "video" ? "Stock video needs a Pexels or Pixabay API key on this deployment." : "No stock photo provider is available.",
    });
  }
  const queries = [input.query.trim().slice(0, 100), ...simplerQueries(input.query)];
  const lists: StockItem[][] = [];
  const errors: FindStockResult["errors"] = [];
  for (const provider of providers) {
    ctx.signal?.throwIfAborted?.();
    try {
      for (const q of queries) {
        const r = await searchStock(p, ctx, { q, kind: input.kind, provider, orientation: input.orientation, page: 1, perPage: input.perPage ?? 15 }, deps);
        if (r.items.length) {
          lists.push(r.items);
          break;
        }
      }
    } catch (raw) {
      const err = raw instanceof AppError ? raw : new AppError("PROVIDER_ERROR", (raw as Error)?.message ?? String(raw));
      if (err.code === "CANCELLED") throw err;
      errors.push({ provider, code: err.code, message: err.opts.userMessage ?? err.message });
    }
  }
  if (errors.length === providers.length) {
    const first = errors[0]!;
    throw new AppError(first.code === "RATE_LIMITED" ? "RATE_LIMITED" : "PROVIDER_ERROR", `Stock search failed (${errors.map((e) => `${e.provider}: ${e.message}`).join("; ")})`, {
      retryable: false,
      userMessage: `${STOCK_ADAPTERS[first.provider].label} search failed: ${first.message}`.slice(0, 280),
    });
  }
  return { candidates: rankStock(lists, input), searched: providers, errors };
}
