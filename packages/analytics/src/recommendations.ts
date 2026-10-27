import type { Experiment, ExperimentResult, GrowthRecommendation } from "@muselaunch/contracts";
import { MetricName } from "@muselaunch/contracts";
import { AppError, type JobHandler, type Platform } from "@muselaunch/platform";
import { generateJson, untrusted } from "@muselaunch/providers";
import { z } from "zod";
import { createExperiment } from "./experiments";
import { insightsOverview } from "./insights";
import { memoryApi } from "./memory";
import { hashId } from "./observations";

const InterpretationSchema = z.object({
  insights: z
    .array(
      z.object({
        text: z.string().max(600),
        basis: z.enum(["measured", "hypothesis"]),
        observationIds: z.array(z.string().max(128)).max(20),
        resultIds: z.array(z.string().max(128)).max(10),
      }),
    )
    .max(10),
  dataGaps: z.array(z.string().max(400)).max(8),
});

const ProposalSchema = z.object({
  recommendations: z
    .array(
      z.object({
        title: z.string().max(200),
        rationale: z.string().max(2000),
        kind: z.enum(["next_experiment", "content", "channel", "audience", "creator", "stop_doing", "other"]),
        observationIds: z.array(z.string().max(128)).max(20),
        resultIds: z.array(z.string().max(128)).max(10),
        preferenceIds: z.array(z.string().max(128)).max(10),
        proposedExperiment: z
          .object({ title: z.string().max(200), hypothesis: z.string().max(1000), primaryMetric: MetricName, variants: z.array(z.string().max(200)).min(2).max(4) })
          .nullable(),
        confidence: z.enum(["low", "medium", "high"]),
      }),
    )
    .min(1)
    .max(3),
});

const SPARK_INSTRUCTIONS = `You interpret an indie app's marketing results for MuseLaunch.
Input: an insights overview (each metric with value or null, source, attribution level and observation ids), the list of missing metrics, and recent experiment results (measured facts, hypotheses, limitations, confidence).
Rules:
- An insight with basis "measured" must restate a number that is in the input and cite its observation ids or result ids.
- Anything about why something happened is basis "hypothesis". Never present correlation as causation; aggregate (account-level) numbers are never attributed to a post or campaign.
- null means not measured. Never treat it as zero and never estimate it.
- List the most important data gaps (e.g. "no installs data", "no per-post views").`;

const WONDER_INSTRUCTIONS = `You are Muse Wonder, MuseLaunch's growth strategist for an indie app developer.
Propose 1–3 next actions, preferably a concrete next experiment that would produce better evidence than what exists today.
Rules:
- Base recommendations on the interpretation and data provided; cite observation ids, result ids and memory preference ids you actually used.
- Respect the founder's remembered preferences, decisions and lessons (memory items). If a memory item changes what you recommend, cite its id in preferenceIds.
- Never promise or predict business results. Rationale explains what we'd learn and why it's worth testing.
- Prefer experiments that can be measured with what's available: tracked links (clicks, link attribution), per-variant manual/imported post stats, RevenueCat (account-level only).
- confidence reflects the evidence: with little or no measured data use "low".
- Don't repeat recommendations that were already made (listed as previous titles).`;

export const recommendationsHandler: JobHandler<"recommendations.generate"> = async (ctx) => {
  const p = ctx.platform;
  const { appId } = ctx.payload;
  const ws = ctx.ws;
  const app = await ws.collection("apps").getOrThrow(appId);
  await ctx.progress(5, "loading results");
  const [overview, resultsPage, previous] = await Promise.all([
    insightsOverview(p, ctx.workspaceId, appId, { compare: "prev" }),
    ws.collection("experimentResults").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 5 }),
    ws.collection("recommendations").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 }),
  ]);
  const results = resultsPage.items;
  const experiments = new Map<string, Experiment>((await ws.collection("experiments").getMany([...new Set(results.map((r) => r.experimentId))])).map((e) => [e.id, e]));
  const knownObs = new Set(overview.metrics.flatMap((m) => m.observationIds));
  for (const r of results) for (const m of r.measured) for (const id of m.observationIds) knownObs.add(id);
  const knownResults = new Set(results.map((r) => r.id));

  const mem = await memoryApi();
  const memory = await mem.retrieveMemory(p, {
    workspaceId: ctx.workspaceId,
    appId,
    task: "recommendations.generate",
    query: [app.name, ...results.map((r) => r.summary), ...overview.missing.map((m) => m.reason)].join(" ").slice(0, 2000),
    limit: 8,
    jobId: ctx.job.id,
  });
  const knownPrefs = new Set(memory.items.map((x) => x.id));

  const compactOverview = {
    range: overview.range,
    metrics: overview.metrics.map((m) => ({ metric: m.metric, value: m.value, currency: m.currency, byCurrency: m.byCurrency, attribution: m.attribution, imported: m.imported, source: m.sources[0]?.label ?? null, comparison: m.comparison, observationIds: m.observationIds.slice(0, 10) })),
    missing: overview.missing.map((m) => `${m.metric}: ${m.reason}`),
  };
  const compactResults = results.map((r) => ({ resultId: r.id, experiment: experiments.get(r.experimentId)?.title, confidence: r.confidence, measured: r.measured, hypotheses: r.hypotheses, limitations: r.limitations }));

  await ctx.progress(25, "interpreting results with Muse Spark");
  const callCtx = { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, actor: ctx.actor, signal: ctx.signal };
  const interpretation = await generateJson(p, {
    ctx: { ...callCtx, task: "recommendations.interpret" },
    model: "spark",
    instructions: SPARK_INSTRUCTIONS,
    input: [`App: ${app.name}${app.tagline ? ` — ${app.tagline}` : ""}`, `Insights overview (last 28 days):\n${JSON.stringify(compactOverview)}`, `Recent experiment results:\n${JSON.stringify(compactResults)}`].join("\n\n"),
    schema: InterpretationSchema,
    schemaName: "GrowthInterpretation",
    maxOutputTokens: 2500,
  });
  const insights = interpretation.data.insights.map((i) => {
    const obs = i.observationIds.filter((id) => knownObs.has(id));
    const res = i.resultIds.filter((id) => knownResults.has(id));
    // An unsupported "measured" insight is downgraded, never passed on as fact.
    return { ...i, observationIds: obs, resultIds: res, basis: i.basis === "measured" && !obs.length && !res.length ? ("hypothesis" as const) : i.basis };
  });

  ctx.throwIfCancelled();
  await ctx.progress(55, "planning next experiment with Muse Wonder");
  const proposal = await generateJson(p, {
    ctx: { ...callCtx, task: "recommendations.propose" },
    model: "wonder",
    instructions: WONDER_INSTRUCTIONS,
    input: [
      `App: ${app.name}${app.tagline ? ` — ${app.tagline}` : ""}${app.category ? ` (${app.category})` : ""}`,
      `Interpretation (Muse Spark):\n${JSON.stringify({ insights, dataGaps: interpretation.data.dataGaps })}`,
      `Measured overview ids you may cite: ${[...knownObs].slice(0, 60).join(", ") || "none"}; result ids: ${[...knownResults].join(", ") || "none"}`,
      untrusted("brand_memory", memory.items.map((x) => `${x.id} (${x.kind}): ${x.text}`).join("\n") || "(no memory yet)", 8000),
      `Previous recommendation titles: ${previous.items.map((r) => r.title).join(" | ") || "none"}`,
    ].join("\n\n"),
    schema: ProposalSchema,
    schemaName: "GrowthRecommendations",
    maxOutputTokens: 3000,
  });

  await ctx.progress(85, "saving recommendations");
  const evidenceIds = new Set(insights.flatMap((i) => [...i.observationIds, ...i.resultIds]));
  const saved: GrowthRecommendation[] = [];
  for (const [i, rec] of proposal.data.recommendations.entries()) {
    const observationIds = rec.observationIds.filter((id) => knownObs.has(id));
    const resultIds = rec.resultIds.filter((id) => knownResults.has(id));
    const preferenceIds = rec.preferenceIds.filter((id) => knownPrefs.has(id));
    const grounded = observationIds.length + resultIds.length > 0;
    const confidence = grounded ? rec.confidence : "low";
    const id = hashId("rec", `${ctx.job.id}:${i}`);
    const { entity } = await ws.collection("recommendations").createIfAbsent(
      {
        id,
        appId,
        title: rec.title,
        rationale: `${rec.rationale}${grounded ? "" : "\n\nBased on limited measured data; treat this as a starting experiment, not a prediction."}`.slice(0, 3000),
        kind: rec.kind,
        basedOn: { observationIds, resultIds, findingIds: [], preferenceIds, sources: [] },
        proposedExperiment: rec.proposedExperiment ?? undefined,
        confidence,
        status: "new",
        usedMemory: preferenceIds.length > 0,
        models: { interpret: interpretation.model, propose: proposal.model },
      },
      { actor: ctx.actor },
    );
    saved.push(entity);
  }
  return {
    refs: saved.map((r) => ({ entity: "recommendations", id: r.id })),
    data: { count: saved.length, usedMemory: saved.some((r) => r.usedMemory), memoryImplementation: mem.implementation, usedGlimmer: memory.usedGlimmer, groundedInsights: evidenceIds.size },
  };
};

export async function acceptRecommendation(p: Platform, workspaceId: string, recId: string, actor: string): Promise<{ recommendation: GrowthRecommendation; experiment: Experiment | null }> {
  const repo = p.db.ws(workspaceId).collection("recommendations");
  const rec = await repo.getOrThrow(recId);
  if (rec.status === "accepted") {
    const experiment = rec.experimentId ? await p.db.ws(workspaceId).collection("experiments").get(rec.experimentId) : null;
    return { recommendation: rec, experiment };
  }
  if (rec.status !== "new") throw new AppError("CONFLICT", `Recommendation is ${rec.status}`);
  let experiment: Experiment | null = null;
  if (rec.proposedExperiment) {
    const metric = MetricName.safeParse(rec.proposedExperiment.primaryMetric);
    if (!metric.success) throw new AppError("BAD_REQUEST", "Proposed experiment has an unsupported primary metric");
    experiment = await createExperiment(
      p,
      workspaceId,
      rec.appId,
      {
        title: rec.proposedExperiment.title,
        hypothesis: rec.proposedExperiment.hypothesis,
        baseline: { description: "", observationIds: rec.basedOn.observationIds.slice(0, 20) },
        variants: rec.proposedExperiment.variants.map((label, i) => ({ key: String.fromCharCode(97 + i), label, publicationIds: [], isControl: i === 0 })),
        primaryMetric: metric.data,
        secondaryMetrics: [],
        launchWindow: {},
        status: "proposed",
      },
      actor,
      { proposedByRecommendationId: rec.id },
    );
  }
  const updated = await repo.update(rec.id, { status: "accepted", experimentId: experiment?.id }, { actor });
  const mem = await memoryApi();
  await mem.rememberPreference(p, { workspaceId, appId: rec.appId, kind: "decision", text: `Accepted recommendation: ${rec.title}`.slice(0, 1000), source: { type: "approval", ref: { entity: "recommendations", id: rec.id } }, actor });
  return { recommendation: updated, experiment };
}

export async function dismissRecommendation(p: Platform, workspaceId: string, recId: string, reason: string | undefined, actor: string): Promise<GrowthRecommendation> {
  const repo = p.db.ws(workspaceId).collection("recommendations");
  const rec = await repo.getOrThrow(recId);
  if (rec.status === "dismissed") return rec;
  if (rec.status !== "new") throw new AppError("CONFLICT", `Recommendation is ${rec.status}`);
  const updated = await repo.update(rec.id, { status: "dismissed", dismissReason: reason?.slice(0, 500) }, { actor });
  const mem = await memoryApi();
  await mem.rememberPreference(p, { workspaceId, appId: rec.appId, kind: "angle_rejected", text: `Dismissed recommendation “${rec.title}”${reason ? `: ${reason}` : ""}`.slice(0, 1000), source: { type: "rejection", ref: { entity: "recommendations", id: rec.id } }, actor });
  return updated;
}

