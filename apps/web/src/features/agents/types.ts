import { modelDisplayName, type AgentRun, type AgentStep, type ModelUsageEvent, type ToolInvocation } from "@muselaunch/contracts";

/** GET /agent-runs/:runId (module B, campaigns.ts). `tools` is an additive field. */
export interface AgentRunDetail {
  run: AgentRun;
  steps: AgentStep[];
  usage: ModelUsageEvent[];
  tools?: ToolInvocation[];
}

export const RUN_KIND_LABEL: Record<AgentRun["kind"], string> = {
  growth_strategy: "Growth strategy",
  research: "Market research",
  app_analysis: "App DNA analysis",
  campaign_concepts: "Campaign concepts",
  storyboard: "Storyboard",
  scene_edit: "AI scene edit",
  claim_validation: "Claim check",
  experiment_analysis: "Experiment analysis",
  outreach_drafting: "Outreach drafting",
  copywriting: "Copywriting",
  growth_autopilot: "Growth Autopilot",
  brand_review: "Brand Guardian review",
  effects_direction: "Effects direction",
};

/**
 * Friendly names for the models (ids stay visible for transparency). Muse Spark Open is always
 * "Muse Spark Open · open weights via Baseten", never "Muse Spark".
 */
export function modelLabel(model?: string): string {
  return modelDisplayName(model);
}

/** Where a metered call ran, for usage tables. */
export function providerNote(u: Pick<ModelUsageEvent, "provider" | "dataMode">): string | null {
  if (u.provider === "baseten") return "open weights via Baseten";
  if (u.dataMode === "self_hosted") return "self-hosted";
  return null;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

export function formatTokens(n?: number): string {
  if (!n) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatMs(ms?: number): string {
  if (!ms) return "0s";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function stepDurationMs(step: { startedAt: string; endedAt?: string }): number | undefined {
  if (!step.endedAt) return undefined;
  return Math.max(0, Date.parse(step.endedAt) - Date.parse(step.startedAt));
}

/** Pretty JSON for collapsible payloads (summaries are already trimmed and redacted server-side). */
export function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
