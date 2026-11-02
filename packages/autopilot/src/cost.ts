/**
 * What a run's AI calls cost, from usage records (one ModelUsageEvent per provider call, written
 * even on error). A run's calls are the ones made by its own Muse Wonder decisions (attributed to
 * their agent runs) plus every call made by the jobs it started and their follow-ups (attributed
 * to those jobs): the same jobs its credits are counted from (runJobs). `Autopilot.spent.usd` only
 * ever held the first part, which is why a run that used most of its credits could show a few cents.
 */
import type { Autopilot, AutopilotRunCost, ModelUsageEvent } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { usageName } from "./progress";
import { runJobs } from "./state";

/** Firestore `in` filters take at most 30 values. */
const IN_MAX = 30;
/** Records read per chunk; a chunk that fills it means some calls weren't counted. */
const PAGE = 1000;

type Usage = Pick<ModelUsageEvent, "id" | "provider" | "model" | "operation" | "costUsdEstimate" | "status">;

/** Calls that aren't one of the named models (file uploads, web fetches, stock search…), by provider. */
const PROVIDER_LABEL: Record<ModelUsageEvent["provider"], string> = {
  meta: "Meta Model API (other calls)",
  openai: "OpenAI",
  glimmer: "Muse Glimmer",
  stock: "Stock media",
  tts: "AI voice",
  web: "Web pages",
  publishing: "Publishing",
  analytics: "Analytics",
  render: "Rendering",
  baseten: "Muse Spark Open",
};
const costName = (u: Usage) => usageName(u) ?? PROVIDER_LABEL[u.provider] ?? u.provider;

/** Sum usage records into the run's cost (pure; `complete` says whether every record was read). */
export function summarizeCost(events: Usage[], opts: { jobs: number; complete: boolean }): AutopilotRunCost {
  const seen = new Set<string>();
  const by = new Map<string, { usd: number; calls: number }>();
  let usd = 0;
  let calls = 0;
  let failed = 0;
  for (const e of events) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    calls += 1;
    if (e.status === "error") failed += 1;
    const cost = Number.isFinite(e.costUsdEstimate) ? Math.max(0, e.costUsdEstimate) : 0;
    usd += cost;
    const name = costName(e);
    const row = by.get(name) ?? { usd: 0, calls: 0 };
    row.usd += cost;
    row.calls += 1;
    by.set(name, row);
  }
  const round = (n: number) => Math.round(n * 10_000) / 10_000;
  const byModel = [...by.entries()]
    .map(([name, r]) => ({ name, usd: round(r.usd), calls: r.calls }))
    .sort((a, b) => b.usd - a.usd || b.calls - a.calls || a.name.localeCompare(b.name))
    .slice(0, 12);
  return { usd: round(usd), calls, failed, jobs: opts.jobs, complete: opts.complete, byModel };
}

async function usageWhere(ws: WorkspaceDb, field: "jobId" | "agentRunId", ids: string[]): Promise<{ items: Usage[]; complete: boolean }> {
  const items: Usage[] = [];
  let complete = true;
  for (let i = 0; i < ids.length; i += IN_MAX) {
    const page = await ws.collection("modelUsage").list({ where: [[field, "in", ids.slice(i, i + IN_MAX)]], limit: PAGE });
    items.push(...page.items);
    if (page.nextCursor) complete = false;
  }
  return { items, complete };
}

/** The run's model cost: its Wonder decisions plus everything the jobs it started called. */
export async function runCost(ws: WorkspaceDb, ap: Pick<Autopilot, "appId" | "log" | "agentRunIds">): Promise<AutopilotRunCost> {
  const jobs = await runJobs(ws, ap.appId, ap.log);
  const [byJob, byRun] = await Promise.all([usageWhere(ws, "jobId", jobs.map((j) => j.id)), usageWhere(ws, "agentRunId", [...new Set(ap.agentRunIds)])]);
  return summarizeCost([...byRun.items, ...byJob.items], { jobs: jobs.length, complete: byJob.complete && byRun.complete });
}

/**
 * GET /autopilots/:id is polled every few seconds while a run works: the cost is cached per run for
 * a few seconds (longer once the run has ended and its jobs have settled).
 */
const cache = new Map<string, { at: number; ttl: number; value: AutopilotRunCost }>();

export async function runCostCached(ws: WorkspaceDb, ap: Pick<Autopilot, "id" | "appId" | "log" | "agentRunIds" | "status" | "updatedAt">): Promise<AutopilotRunCost> {
  const key = `${ws.workspaceId}:${ap.id}:${ap.updatedAt}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value;
  const value = await runCost(ws, ap);
  const ended = ap.status === "completed" || ap.status === "cancelled" || ap.status === "failed";
  if (cache.size > 500) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), ttl: ended ? 60_000 : 10_000, value });
  return value;
}
