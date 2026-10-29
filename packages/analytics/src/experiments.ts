import type { CreateExperimentRequest, Experiment, ExperimentResult, MetricName, MetricObservation } from "@muselaunch/contracts";
import { MetricName as MetricNameSchema, UpdateExperimentRequest } from "@muselaunch/contracts";
import { AppError, type JobContext, type JobHandler, type Platform } from "@muselaunch/platform";
import { generateJson, roleNames, untrusted } from "@muselaunch/providers";
import { z } from "zod";
import { computeMetric } from "./insights";
import { memoryApi } from "./memory";
import { ATTRIBUTION_STRENGTH, METRIC_INFO, sourceLabel, weakestAttribution } from "./metrics";
import { hashId } from "./observations";

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createExperiment(p: Platform, workspaceId: string, appId: string, input: CreateExperimentRequest, actor: string, extra: { proposedByRecommendationId?: string } = {}): Promise<Experiment> {
  const ws = p.db.ws(workspaceId);
  await ws.collection("apps").getOrThrow(appId);
  if (input.campaignId) {
    const c = await ws.collection("campaigns").getOrThrow(input.campaignId);
    if (c.appId !== appId) throw new AppError("BAD_REQUEST", "Campaign belongs to another app");
  }
  await validateVariants(p, workspaceId, appId, input.variants);
  if (input.baseline.observationIds.length) {
    const found = await ws.collection("metricObservations").getMany(input.baseline.observationIds);
    if (found.length !== new Set(input.baseline.observationIds).size || found.some((o) => o.appId !== appId)) throw new AppError("BAD_REQUEST", "Baseline references unknown observations");
  }
  return ws.collection("experiments").create(
    {
      appId,
      campaignId: input.campaignId,
      title: input.title,
      hypothesis: input.hypothesis,
      baseline: input.baseline,
      variants: input.variants,
      primaryMetric: input.primaryMetric,
      secondaryMetrics: input.secondaryMetrics,
      launchWindow: input.launchWindow,
      status: input.status,
      proposedByRecommendationId: extra.proposedByRecommendationId,
    },
    { actor },
  );
}

async function validateVariants(p: Platform, workspaceId: string, appId: string, variants: CreateExperimentRequest["variants"]) {
  const keys = variants.map((v) => v.key);
  if (new Set(keys).size !== keys.length) throw new AppError("BAD_REQUEST", "Variant keys must be unique");
  if (variants.filter((v) => v.isControl).length > 1) throw new AppError("BAD_REQUEST", "Only one variant can be the control");
  const pubIds = [...new Set(variants.flatMap((v) => v.publicationIds))];
  if (pubIds.length) {
    const pubs = await p.db.ws(workspaceId).collection("publications").getMany(pubIds);
    if (pubs.length !== pubIds.length || pubs.some((x) => x.appId !== appId)) throw new AppError("BAD_REQUEST", "A variant references an unknown publication");
  }
}

const TRANSITIONS: Record<Experiment["status"], Experiment["status"][]> = {
  proposed: ["running", "abandoned", "concluded"],
  running: ["analyzing", "concluded", "abandoned"],
  analyzing: ["running", "concluded", "abandoned"],
  concluded: [],
  abandoned: [],
};

export async function updateExperiment(p: Platform, workspaceId: string, experimentId: string, raw: unknown, actor: string): Promise<Experiment> {
  const input = UpdateExperimentRequest.parse(raw);
  const repo = p.db.ws(workspaceId).collection("experiments");
  const exp = await repo.getOrThrow(experimentId);
  if (input.status && input.status !== exp.status && !TRANSITIONS[exp.status].includes(input.status)) {
    throw new AppError("CONFLICT", `Can't move an experiment from ${exp.status} to ${input.status}`);
  }
  if (input.variants) await validateVariants(p, workspaceId, exp.appId, input.variants);
  if (input.status === "concluded" && !input.decision && !exp.decision) throw new AppError("BAD_REQUEST", "Record a decision when concluding an experiment");
  const updated = await repo.update(experimentId, { ...input }, { actor });
  if (input.status === "concluded" && exp.status !== "concluded") {
    const mem = await memoryApi();
    const result = updated.lastResultId ? await p.db.ws(workspaceId).collection("experimentResults").get(updated.lastResultId) : null;
    const text = `Experiment “${updated.title}” concluded: ${updated.decision}${result ? ` (analysis confidence: ${result.confidence})` : ""}`;
    await mem.rememberPreference(p, { workspaceId, appId: exp.appId, kind: "lesson", text: text.slice(0, 1000), source: { type: "experiment", ref: { entity: "experiments", id: exp.id } }, actor });
  }
  return updated;
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

export interface ExperimentData {
  observations: MetricObservation[];
  /** observation id → variant key (or "baseline") */
  assignment: Map<string, string>;
}

export async function gatherExperimentData(p: Platform, workspaceId: string, exp: Experiment): Promise<ExperimentData> {
  const ws = p.db.ws(workspaceId);
  const byId = new Map<string, MetricObservation>();
  const assignment = new Map<string, string>();
  const keys = new Set(exp.variants.map((v) => v.key));
  const pubToVariant = new Map<string, string>();
  for (const v of exp.variants) for (const pid of v.publicationIds) pubToVariant.set(pid, v.key);

  const direct = await ws.collection("metricObservations").list({ where: [["experimentId", "==", exp.id]], limit: 1000 });
  for (const o of direct.items) byId.set(o.id, o);
  const pubIds = [...pubToVariant.keys()];
  for (let i = 0; i < pubIds.length; i += 30) {
    const page = await ws.collection("metricObservations").list({ where: [["publicationId", "in", pubIds.slice(i, i + 30)]], limit: 1000 });
    for (const o of page.items) byId.set(o.id, o);
  }
  if (exp.campaignId) {
    const page = await ws.collection("metricObservations").list({ where: [["campaignId", "==", exp.campaignId]], orderBy: { field: "windowStart", dir: "desc" }, limit: 1000 });
    for (const o of page.items) if (o.variantKey && keys.has(o.variantKey)) byId.set(o.id, o);
  }
  const start = exp.launchWindow.start ? Date.parse(exp.launchWindow.start) : -Infinity;
  const end = exp.launchWindow.end ? Date.parse(exp.launchWindow.end) : Infinity;
  const observations: MetricObservation[] = [];
  for (const o of byId.values()) {
    if (o.appId !== exp.appId) continue;
    if (Date.parse(o.windowStart) < start || Date.parse(o.windowEnd) > end) continue;
    const key = o.variantKey && keys.has(o.variantKey) ? o.variantKey : o.publicationId ? pubToVariant.get(o.publicationId) : undefined;
    if (!key) continue;
    assignment.set(o.id, key);
    observations.push(o);
  }
  if (exp.baseline.observationIds.length) {
    for (const o of await ws.collection("metricObservations").getMany(exp.baseline.observationIds)) {
      if (o.appId !== exp.appId || assignment.has(o.id)) continue;
      assignment.set(o.id, "baseline");
      observations.push(o);
    }
  }
  return { observations, assignment };
}

export function perVariantMetrics(exp: Experiment, data: ExperimentData): ExperimentResult["perVariant"] {
  const metrics = [exp.primaryMetric, ...exp.secondaryMetrics].filter((m): m is MetricName => MetricNameSchema.safeParse(m).success);
  const groups = [...exp.variants.map((v) => v.key), ...(exp.baseline.observationIds.length ? ["baseline"] : [])];
  return groups.map((key) => {
    const obs = data.observations.filter((o) => data.assignment.get(o.id) === key);
    return {
      key,
      metrics: metrics.map((metric) => {
        const relevant = obs.filter((o) => o.metric === metric);
        if (!relevant.length) return { metric, value: null, observationIds: [], note: "not measured" };
        const span = { from: Math.min(...relevant.map((o) => Date.parse(o.windowStart))), to: Math.max(...relevant.map((o) => Date.parse(o.windowEnd))) };
        const m = computeMetric(metric, relevant, span, {});
        const note = m.byCurrency ? `multiple currencies: ${m.byCurrency.map((c) => `${c.value} ${c.currency}`).join(", ")}` : m.attribution ? `${m.attribution} attribution${m.imported ? ", imported/manual" : ""}` : undefined;
        return { metric, value: m.value, observationIds: m.observationIds, note: note?.slice(0, 300) };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// Validation of model output (pure, tested)
// ---------------------------------------------------------------------------

const CAUSAL = /\b(caused|causes|because of|led to|leads to|drove|drives|driving|resulted in|results in|due to|thanks to|made (?:people|users)|increased? .* by (?:showing|using)|boosted|is why)\b/i;

/** Numbers a measured statement may quote: raw values, per-variant values, and their sums, differences and ratios. */
export function allowedNumbers(observations: MetricObservation[], perVariant: ExperimentResult["perVariant"]): number[] {
  const nums = new Set<number>();
  for (const o of observations) nums.add(o.value);
  const byMetric = new Map<string, number[]>();
  for (const v of perVariant)
    for (const m of v.metrics) {
      if (m.value === null) continue;
      nums.add(m.value);
      byMetric.set(m.metric, [...(byMetric.get(m.metric) ?? []), m.value]);
    }
  for (const vals of byMetric.values()) {
    for (const a of vals)
      for (const b of vals) {
        if (a === b) continue;
        nums.add(Math.abs(a - b));
        if (b !== 0) {
          nums.add((a / b) * 100);
          nums.add(((a - b) / Math.abs(b)) * 100);
          nums.add(Math.abs(((a - b) / Math.abs(b)) * 100));
          nums.add(a / b);
        }
      }
  }
  // ratios between metrics within a variant (e.g. clicks per view)
  for (const v of perVariant) {
    const vals = v.metrics.filter((m) => m.value !== null && m.value !== 0).map((m) => m.value!);
    for (const a of vals) for (const b of vals) if (a !== b) nums.add((a / b) * 100);
  }
  return [...nums];
}

function numbersIn(text: string): number[] {
  const cleaned = text
    .replace(/\b\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?\b/g, " ")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:, \d{4})?\b/gi, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:obs|exp|pub|var|cpg|exr|rec)_[a-z0-9]+\b/gi, " ");
  return [...cleaned.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ""))).filter((n) => Number.isFinite(n));
}

function numberAllowed(n: number, allowed: number[]): boolean {
  if (Math.abs(n) < 10 && Number.isInteger(n)) return true; // small counts ("2 variants", "3 days")
  return allowed.some((a) => Math.abs(a - n) <= Math.max(0.01, Math.abs(a) * 0.01) || Math.abs(Math.round(a) - n) < 0.5 || Math.abs(Math.round(a * 10) / 10 - n) < 0.05);
}

export const AnalysisSchema = z.object({
  summary: z.string().max(3000),
  measured: z.array(z.object({ text: z.string().max(600), observationIds: z.array(z.string().max(128)).max(50) })).max(20),
  hypotheses: z.array(z.string().max(600)).max(10),
  limitations: z.array(z.string().max(600)).max(10),
  confidence: z.enum(["insufficient_data", "low", "medium", "high"]),
});
export type AnalysisOutput = z.infer<typeof AnalysisSchema>;

export interface ValidatedAnalysis {
  summary: string;
  measured: { text: string; observationIds: string[] }[];
  hypotheses: string[];
  limitations: string[];
  confidence: ExperimentResult["confidence"];
  validation: NonNullable<ExperimentResult["validation"]>;
}

const ORDER: ExperimentResult["confidence"][] = ["insufficient_data", "low", "medium", "high"];
const minConf = (a: ExperimentResult["confidence"], b: ExperimentResult["confidence"]) => (ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b);

/**
 * Server-side guard on the model's analysis:
 * - measured statements must cite only observation ids that were provided (else dropped);
 * - causal wording in a measured statement moves it to hypotheses;
 * - figures in measured statements must match the cited data (else dropped);
 * - confidence is capped by the data: missing variant data ⇒ insufficient_data; aggregate attribution ⇒ low.
 */
export function validateAnalysis(out: AnalysisOutput, exp: Experiment, data: ExperimentData, perVariant: ExperimentResult["perVariant"]): ValidatedAnalysis {
  const known = new Map(data.observations.map((o) => [o.id, o]));
  const notes: string[] = [];
  const measured: ValidatedAnalysis["measured"] = [];
  const hypotheses = [...out.hypotheses];
  const limitations = [...out.limitations];
  let dropped = 0;
  let moved = 0;
  const allowed = allowedNumbers(data.observations, perVariant);
  for (const m of out.measured) {
    const ids = [...new Set(m.observationIds)];
    const unknown = ids.filter((id) => !known.has(id));
    if (!ids.length || unknown.length) {
      dropped++;
      notes.push(`Removed a “measured” statement that cited ${ids.length ? `unknown observation ids (${unknown.slice(0, 3).join(", ")})` : "no observations"}.`);
      continue;
    }
    if (CAUSAL.test(m.text)) {
      moved++;
      hypotheses.push(`Hypothesis (not measured): ${m.text}`.slice(0, 600));
      notes.push("Moved a statement with causal wording from “measured” to hypotheses.");
      continue;
    }
    const bad = numbersIn(m.text).filter((n) => !numberAllowed(n, allowed));
    if (bad.length) {
      dropped++;
      notes.push(`Removed a “measured” statement quoting figures not found in the cited data (${bad.slice(0, 3).join(", ")}).`);
      continue;
    }
    measured.push({ text: m.text, observationIds: ids });
  }

  let confidence = out.confidence;
  let capped = false;
  const cap = (c: ExperimentResult["confidence"], why: string) => {
    const next = minConf(confidence, c);
    if (next !== confidence) {
      confidence = next;
      capped = true;
      notes.push(why);
    }
  };
  const variantRows = perVariant.filter((v) => v.key !== "baseline");
  const withPrimary = variantRows.filter((v) => (v.metrics.find((m) => m.metric === exp.primaryMetric)?.value ?? null) !== null);
  if (!data.observations.length || withPrimary.length === 0) cap("insufficient_data", "Confidence set to insufficient data: no variant has a measured primary metric.");
  else if (exp.variants.length > 1 && withPrimary.length < exp.variants.length) cap("insufficient_data", "Confidence set to insufficient data: not every variant has a measured primary metric.");
  const primaryObs = data.observations.filter((o) => o.metric === exp.primaryMetric && data.assignment.get(o.id) !== "baseline");
  const weakest = weakestAttribution(primaryObs.map((o) => o.attribution));
  if (weakest && ATTRIBUTION_STRENGTH[weakest] <= ATTRIBUTION_STRENGTH.aggregate) {
    cap("low", "Confidence capped at low: the primary metric is account-level (aggregate), so differences can't be attributed to a variant.");
    const lim = "The primary metric is an account-level number. Any difference between variants is a correlation, not a measured effect of the variant.";
    if (!limitations.includes(lim)) limitations.push(lim);
  }
  if (primaryObs.some((o) => o.provenance.imported)) {
    const lim = "Some numbers were imported or entered manually; they are only as accurate as the source they were copied from.";
    if (!limitations.includes(lim)) limitations.push(lim);
  }
  if (dropped && !measured.length && confidence !== "insufficient_data") cap("low", "Confidence capped at low: none of the model's measured statements could be verified.");
  return { summary: out.summary, measured, hypotheses: hypotheses.slice(0, 20), limitations: limitations.slice(0, 20), confidence, validation: { droppedMeasured: dropped, movedToHypotheses: moved, confidenceCapped: capped, notes: notes.slice(0, 20) } };
}

// ---------------------------------------------------------------------------
// Job: experiment.analyze
// ---------------------------------------------------------------------------

const INSTRUCTIONS = `You are MuseLaunch's experiment analyst for an indie app developer.
You receive an experiment definition and a table of observations. Each observation has an id, the variant it belongs to, its metric, value, window, source, attribution level and definition.
Rules:
- "measured" statements may only state facts that follow directly from the listed observations, and every statement must cite the ids of the observations it uses. Quote only numbers that appear in the table or simple sums/differences/percent differences of them.
- Never claim that a variant caused, drove or led to an outcome. Explanations of why something happened go in "hypotheses" and must be phrased as possibilities.
- Account-level ("aggregate") numbers are not attributed to any variant; say so in limitations when they are used.
- List limitations honestly: small samples, missing variants, imported/manual data, overlapping launches, short windows.
- If the data cannot answer the experiment's question, set confidence to "insufficient_data" and explain what's missing.
- Write plainly for a busy founder. No marketing language.`;

function observationTable(data: ExperimentData): string {
  return data.observations
    .map((o) => {
      const v = data.assignment.get(o.id);
      return `${o.id} | variant=${v} | ${o.metric} = ${o.value}${o.currency ? ` ${o.currency}` : ""} | ${o.windowStart.slice(0, 10)}→${o.windowEnd.slice(0, 10)} | ${sourceLabel(o)} | attribution=${o.attribution} | def: ${o.metricDefinition.slice(0, 160)}`;
    })
    .join("\n");
}

export async function analyzeExperiment(ctx: JobContext<"experiment.analyze">): Promise<{ result: ExperimentResult; modelCalled: boolean }> {
  const p = ctx.platform;
  const { appId, experimentId } = ctx.payload;
  const exp = await ctx.ws.collection("experiments").getOrThrow(experimentId);
  if (exp.appId !== appId) throw new AppError("BAD_REQUEST", "Experiment belongs to another app", { retryable: false });
  await ctx.progress(10, "gathering observations");
  const data = await gatherExperimentData(p, ctx.workspaceId, exp);
  const perVariant = perVariantMetrics(exp, data);
  const resultId = hashId("exr", `${ctx.job.id}`);
  const repo = ctx.ws.collection("experimentResults");
  const existing = await repo.get(resultId);
  if (existing) return { result: existing, modelCalled: false };

  let body: Omit<ExperimentResult, "id" | "workspaceId" | "createdAt" | "updatedAt" | "createdBy" | "appId" | "experimentId" | "perVariant">;
  let modelCalled = false;
  if (!data.observations.length) {
    body = {
      summary: "There is no measured data linked to this experiment's variants yet, so it can't be analysed.",
      measured: [],
      hypotheses: [],
      limitations: [
        "No observations are linked to the variants. Link publications to variants, add tracked links, or import/enter per-variant numbers.",
        ...(exp.variants.every((v) => !v.publicationIds.length) ? ["No variant has a publication attached."] : []),
      ],
      confidence: "insufficient_data",
      validation: { droppedMeasured: 0, movedToHypotheses: 0, confidenceCapped: false, notes: ["No model call was made because there was nothing to analyse."] },
    };
  } else {
    await ctx.progress(35, `analysing with ${roleNames(p).spark}`);
    const input = [
      `Experiment: ${exp.title}`,
      `Hypothesis: ${exp.hypothesis}`,
      `Primary metric: ${exp.primaryMetric} (${METRIC_INFO[exp.primaryMetric as MetricName]?.label ?? exp.primaryMetric}); secondary: ${exp.secondaryMetrics.join(", ") || "none"}`,
      `Variants: ${exp.variants.map((v) => `${v.key}${v.isControl ? " (control)" : ""}: ${v.label}`).join("; ")}`,
      exp.baseline.description ? `Baseline: ${exp.baseline.description}` : "",
      `Per-variant totals computed by MuseLaunch (non-overlapping windows; null = not measured):\n${JSON.stringify(perVariant)}`,
      untrusted("observations", `id | variant | metric = value | window | source | attribution | definition\n${observationTable(data)}`, 40_000),
    ]
      .filter(Boolean)
      .join("\n\n");
    const out = await generateJson(p, {
      ctx: { workspaceId: ctx.workspaceId, task: "experiment.analyze", appId, jobId: ctx.job.id, actor: ctx.actor, signal: ctx.signal },
      model: "spark",
      instructions: INSTRUCTIONS,
      input,
      schema: AnalysisSchema,
      schemaName: "ExperimentAnalysis",
      maxOutputTokens: 3000,
    });
    modelCalled = true;
    const v = validateAnalysis(out.data, exp, data, perVariant);
    body = { ...v, model: out.model };
  }
  ctx.throwIfCancelled();
  const { entity: result } = await repo.createIfAbsent({ id: resultId, appId, experimentId: exp.id, perVariant, ...body }, { actor: ctx.actor });
  await ctx.ws.collection("experiments").update(exp.id, { lastResultId: result.id }, { actor: ctx.actor });
  return { result, modelCalled };
}

export const experimentAnalyzeHandler: JobHandler<"experiment.analyze"> = async (ctx) => {
  const { result, modelCalled } = await analyzeExperiment(ctx);
  return { refs: [{ entity: "experimentResults", id: result.id }], data: { confidence: result.confidence, modelCalled }, creditsUsed: modelCalled ? undefined : 0 };
};
