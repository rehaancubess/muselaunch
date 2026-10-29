/**
 * Provider price table (USD) used for cost metering and spend guards.
 * Meta prices from https://dev.meta.ai/docs/pricing-rate-limits (verified 2026-10-27).
 * Baseten Model APIs prices from https://www.baseten.co/pricing/ (verified 2026-10-29).
 * Override any entry with PROVIDER_PRICES_JSON (same shape) without a code change.
 */
export interface TokenPrice {
  inputPerM: number;
  outputPerM: number;
  cachedInputPerM: number;
}

export const PRICES = {
  tokens: {
    "muse-wonder-1.0": { inputPerM: 4.0, outputPerM: 20.0, cachedInputPerM: 0.2 },
    "muse-spark-1.3": { inputPerM: 1.25, outputPerM: 4.25, cachedInputPerM: 0.15 },
    "muse-spark-1.2": { inputPerM: 1.25, outputPerM: 4.25, cachedInputPerM: 0.15 },
    "muse-spark-1.1": { inputPerM: 1.25, outputPerM: 4.25, cachedInputPerM: 0.15 },
    // Self-hosted: no per-token charge (GPU time is tracked separately via runtimeMs).
    "muse-glimmer": { inputPerM: 0, outputPerM: 0, cachedInputPerM: 0 },
    // Baseten "Meta AI Muse Spark Open": $1.25 input / $0.15 cached input / $4.25 output per 1M tokens.
    // Reasoning is billed as output: "Baseten includes reasoning tokens in completion_tokens and counts
    // them toward your total usage and billing" (docs.baseten.co/inference/model-apis/reasoning).
    "meta-models/muse-spark-open-1026": { inputPerM: 1.25, outputPerM: 4.25, cachedInputPerM: 0.15 },
    "meta-models/muse-spark-open": { inputPerM: 1.25, outputPerM: 4.25, cachedInputPerM: 0.15 },
  } as Record<string, TokenPrice>,
  metaWebSearchPerQuery: 2.5 / 1000,
  museImagePerImage: 0.01,
  samPerImage: 2.5 / 1000,
  samPerVideoFrame: 0.2 / 1000,
  samMinFramesPerVideoRequest: 50,
  voicePerHour: 0.18,
  /** Fallback per-image estimate when token usage is absent (OpenAI images; overridable). */
  openaiImagePerImage: 0.07,
  openaiTtsPer1kChars: 0.015,
};

let overridesApplied = false;
function applyOverrides() {
  if (overridesApplied) return;
  overridesApplied = true;
  const raw = process.env.PROVIDER_PRICES_JSON;
  if (raw) Object.assign(PRICES, JSON.parse(raw));
}

export function tokenCost(model: string, usage: { inputTokens?: number; outputTokens?: number; cachedTokens?: number }): number {
  applyOverrides();
  const p = PRICES.tokens[model] ?? PRICES.tokens["muse-spark-1.3"]!;
  const cached = usage.cachedTokens ?? 0;
  const uncached = Math.max(0, (usage.inputTokens ?? 0) - cached);
  return (uncached * p.inputPerM + cached * p.cachedInputPerM + (usage.outputTokens ?? 0) * p.outputPerM) / 1_000_000;
}

/** Conservative pre-call estimate for spend guards. */
export function estimateTokenCost(model: string, approxInputTokens: number, maxOutputTokens: number): number {
  return tokenCost(model, { inputTokens: approxInputTokens, outputTokens: maxOutputTokens });
}

export function samCost(kind: "image" | "video", frames = 0): number {
  applyOverrides();
  if (kind === "image") return PRICES.samPerImage;
  return Math.max(frames, PRICES.samMinFramesPerVideoRequest) * PRICES.samPerVideoFrame;
}

export function voiceCost(seconds: number): number {
  applyOverrides();
  return (Math.floor(seconds) / 3600) * PRICES.voicePerHour;
}

export const approxTokens = (text: string) => Math.ceil(text.length / 3.6);
