import { applyFinding, brandGate, truncateWords, dnaSummary, ingestMemory, isTerminalReview, loadAppContext, requestBrandReview, retrieveMemory, reviewsFor, validateClaims } from "@muselaunch/agents";
import { createTrackedLink, gatherExperimentData } from "@muselaunch/analytics";
import { collectAssetRefs, lintDoc, totalDuration } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import { MetricName, type BrandFinding, type BrandReview, type CampaignGoal, type Channel, type Composition, type CompositionDoc, type EntityRef, type Job, type ResearchFinding, type SourceRef } from "@muselaunch/contracts";
import { createPost, requestPostApproval, suggestTimes } from "@muselaunch/growth";
import { AppError, notifyPostsReady, toAppError } from "@muselaunch/platform";
import { chooseTextModel, roleNames, untrusted, type TextRoute } from "@muselaunch/providers";
import { z } from "zod";
import { ALWAYS_ON_NEXT_INSTRUCTIONS, alwaysOnFocusLine, alwaysOnMeasure, alwaysOnNextRound, alwaysOnResearch, alwaysOnTimes, NEXT_ROUND_TAG } from "./always-on-loop";
import { decide } from "./decide";
import { defaultGoal, dnaJobsInFlight, hasRealAppMedia, screenJobsInFlight } from "./defaults";
import { postingTarget } from "./posting";
import { fail, hashId, isTerminalJob, nowMs, type LoopEnv, type Outcome, type Stage } from "./state";
import { isWatchTag, watchRenders, watchStep } from "./watch";

/** Who a delegated step will run on (providers/router.ts), named honestly in the Autopilot log. */
function engine(env: LoopEnv, route: TextRoute): string {
  const c = chooseTextModel(env.p, route);
  return c.engine === "muse-spark-open" ? "Muse Spark Open (open weights via Baseten)" : c.name;
}

export interface StepInfo {
  phase: "enter" | "resume" | "approved";
  /** Sub-phase tag (from waitingOn.reason) for resume/approved phases. */
  tag?: string;
  /** The user approved a checkpoint that gated this exact sub-phase. */
  approved: boolean;
}

export type StageFn = (env: LoopEnv, step: StepInfo) => Promise<Outcome>;

const RESEARCH_KINDS = ["audience", "trends", "competitors", "opportunities"] as const;
export const MAX_FIX_ROUNDS = 2;
export const MEASURE_DAYS = 7;
const DAY_MS = 86_400_000;

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : (s ?? ""));
const ref = (entity: string, id: string): EntityRef => ({ entity, id });

/** Jobs this loop delegated (from the decision log), optionally filtered, in log order. */
async function delegated(env: LoopEnv, type: Job["type"], where: (j: Job) => boolean = () => true): Promise<Job[]> {
  const ids = [...new Set(env.fullLog.flatMap((e) => e.refs.filter((r) => r.entity === "jobs").map((r) => r.id)))];
  const jobs = await env.ws.collection("jobs").getMany(ids);
  return jobs.filter((j) => j.type === type && where(j));
}

const jobError = (j: Job) => j.error?.userMessage ?? j.error?.message ?? j.status;

async function findingsFor(env: LoopEnv, limit = 30): Promise<ResearchFinding[]> {
  const page = await env.ws.collection("researchFindings").list({ where: [["appId", "==", env.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 80 });
  const own = env.ap.researchRunId ? page.items.filter((f) => f.runId === env.ap.researchRunId) : [];
  return [...own, ...page.items.filter((f) => !own.includes(f))].slice(0, limit);
}

function findingLines(findings: ResearchFinding[]): string {
  return findings.map((f) => `- ${f.id} [${f.kind}] ${clip(f.statement, 300)}${f.interpretation ? ` → ${clip(f.interpretation, 200)}` : ""} (sources: ${f.evidence.map((e) => e.url).filter(Boolean).slice(0, 2).join(", ")})`).join("\n");
}

function citationsOf(findings: ResearchFinding[], ids: string[]): SourceRef[] {
  const byId = new Map(findings.map((f) => [f.id, f]));
  return ids.flatMap((id) => byId.get(id)?.evidence.slice(0, 2) ?? []).slice(0, 12);
}

function citeCheck(findings: ResearchFinding[], ids: string[]): string | null {
  const known = new Set(findings.map((f) => f.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length) return `Unknown finding ids: ${unknown.join(", ")}. Cite ids from the findings list only.`;
  if (findings.length && !ids.length) return "Cite at least one finding id that supports this decision.";
  return null;
}

// ---------------------------------------------------------------------------
// understand
// ---------------------------------------------------------------------------

/** Accept App DNA on the founder's behalf (Autopilot on): same effect as `POST /apps/:appId/dna/confirm`, attributed to the loop. */
async function acceptDnaAutomatically(env: LoopEnv, app: Awaited<ReturnType<typeof loadAppContext>>): Promise<void> {
  const dna = app.dna!;
  const profile = await env.ws.collection("brandProfiles").update(env.appId, { status: "confirmed", confirmedBy: `agent:autopilot:${env.ap.id}`, confirmedAt: new Date(nowMs(env.p)).toISOString() }, { actor: env.ctx.actor });
  await env.ws.collection("apps").update(env.appId, { dnaStatus: "confirmed", status: "ready" }, { actor: env.ctx.actor });
  await env.ctx.enqueue("memory.ingest", { appId: env.appId, ref: ref("brandProfiles", env.appId) }, { idempotencyKey: `memory.ingest:dna:${env.appId}:v${profile.version}`, appId: env.appId }).catch(() => undefined);
  env.note(
    "action",
    `Accepted what we learned about your app automatically because Autopilot is on: ${dna.features.length} features, ${dna.audiences.length} audiences, ${app.verifiedClaims.length} confirmed facts. Videos only state confirmed facts. Check or edit it any time in About your app.`,
    [ref("brandProfiles", env.appId)],
  );
}

const understand: StageFn = async (env, step) => {
  let app = await loadAppContext(env.ws, env.appId);
  if (!app.dna) {
    // The app is still being imported or analysed (e.g. the run started right after the app was
    // added): wait for that work instead of starting a second analysis.
    const inflight = await dnaJobsInFlight(env.ws, env.appId);
    if (inflight.length) {
      const importing = inflight.some((j) => j.type === "app.import");
      return { kind: "wait", jobIds: inflight.map((j) => j.id), tag: "understand:import", reason: importing ? "Reading your app’s listing and saving its screenshots" : `${roleNames(env.p).spark} is learning about your app` };
    }
    if (step.phase === "resume" && step.tag === "understand:import") {
      const failed = (await env.jobs()).find((j) => j.status !== "succeeded");
      if (failed) throw fail("BAD_REQUEST", `App import or analysis didn't finish (${jobError(failed)})`, "MuseLaunch couldn't finish learning your app from its listing, so Autopilot has nothing to work from yet. Retry the import or describe your app in About your app, then resume.");
      // Imported, but the analysis never started (e.g. credits ran short then): run it inside the budget.
    } else if (step.phase === "resume") {
      const [job] = await delegated(env, "app.analyze");
      throw fail("BAD_REQUEST", `App DNA could not be built (${job ? jobError(job) : "no analysis job"})`, "Autopilot needs to learn about your app first. Import your listing or describe your app, then resume.");
    }
    const gate = await env.budgetGate(env.estimate("app.analyze"), "learning about your app", step.approved);
    if (gate) return gate;
    const job = await env.delegate("app.analyze", { appId: env.appId, refresh: false }, { key: "understand:dna", label: `Nothing learned about the app yet: asked ${roleNames(env.p).spark} to read the real listing and screenshots.`, credits: { operation: "app.analyze" } });
    return { kind: "wait", jobIds: [job.id], tag: "understand:dna", reason: "Learning about your app from its listing" };
  }
  if (env.ap.auto?.acceptDna && app.dna.status !== "confirmed") {
    await acceptDnaAutomatically(env, app);
    app = await loadAppContext(env.ws, env.appId);
  }
  const dna = app.dna!;
  if (env.ap.auto?.goal) {
    const { goal } = defaultGoal(app.app, dna);
    const first = dna.audiences[0]?.name;
    env.set({ goal, auto: { ...env.ap.auto, goal: false } });
    env.note("decision", `Goal set from what we learned about your app: “${goal}”${first ? ` (${first} is the first audience it lists)` : ""}. Start a run with your own goal any time to change it.`, [ref("brandProfiles", env.appId)]);
  }
  const memory = await retrieveMemory(env.p, { workspaceId: env.ctx.workspaceId, appId: env.appId, task: "growth_strategy", query: env.ap.goal, jobId: env.ctx.job.id });
  env.note(
    "observation",
    `Understood ${app.app.name}: ${dna.oneLiner} ${dna.features.length} features, ${app.verifiedClaims.length} confirmed facts, ${dna.audiences.length} audiences. Memory: ${memory.items.length} item(s) via ${memory.usedGlimmer ? "Muse Glimmer (self-hosted)" : "deterministic ranking (Glimmer not connected)"}.`,
    [ref("brandProfiles", env.appId), ...memory.items.slice(0, 5).map((m) => ref("brandPreferences", m.id))],
  );
  return { kind: "advance", to: "research" };
};

// ---------------------------------------------------------------------------
// research
// ---------------------------------------------------------------------------

const research: StageFn = async (env, step) => {
  if (step.phase !== "resume") {
    // Always on: this week's research is reused instead of paid for again.
    const reuse = await alwaysOnResearch(env);
    if (reuse) return reuse;
    const gate = await env.budgetGate(env.estimate("research.run"), "research", step.approved);
    if (gate) return gate;
    const app = await env.ws.collection("apps").getOrThrow(env.appId);
    const lastLearn = [...env.fullLog].reverse().find((e) => e.stage === "learn" && e.kind === "decision");
    const focus = clip(`${env.ap.goal}${lastLearn && env.iteration > 1 ? ` — iteration ${env.iteration} focus: ${lastLearn.summary}` : ""}${env.ap.alwaysOn?.roundFocus ? ` — ${alwaysOnFocusLine(env)}` : ""}`, 1000);
    const rrId = hashId("rsr", env.ap.id, env.iteration);
    await env.ws.collection("researchRuns").createIfAbsent(
      { id: rrId, appId: env.appId, kinds: [...RESEARCH_KINDS], status: "queued", inputs: { countries: app.targetCountries, languages: app.targetLanguages, channels: [], competitorIds: [], focus } },
      { actor: env.ctx.actor },
    );
    const job = await env.delegate("research.run", { appId: env.appId, researchRunId: rrId, kinds: [...RESEARCH_KINDS] }, { key: "research", label: "Delegated audience, trend, competitor and opportunity research to Muse Wonder (live web search; every finding cited).", credits: { operation: "research.run" } });
    await env.ws.collection("researchRuns").update(rrId, { jobId: job.id }, { actor: env.ctx.actor });
    env.set({ researchRunId: rrId });
    return { kind: "wait", jobIds: [job.id], tag: "research", reason: `${roleNames(env.p).wonder} is researching audiences, trends and competitors` };
  }
  const rr = env.ap.researchRunId ? await env.ws.collection("researchRuns").get(env.ap.researchRunId) : null;
  const findings = await findingsFor(env, 12);
  const own = findings.filter((f) => f.runId === env.ap.researchRunId);
  env.note(
    "observation",
    `Research ${rr?.status ?? "missing"}: ${rr?.findingCount ?? 0} sourced finding(s).${rr?.summary ? ` ${clip(rr.summary, 600)}` : ""}`,
    [...(rr ? [ref("researchRuns", rr.id)] : []), ...own.slice(0, 8).map((f) => ref("researchFindings", f.id)), ...(rr?.agentRunId ? [ref("agentRuns", rr.agentRunId)] : [])],
  );
  // No sourced findings at all (failed, cancelled, or a partial run that saved none): stop rather than
  // choose the audience from App DNA alone. Live 30 Oct: a partial run with 0 findings went ahead.
  if (!findings.length) {
    throw fail("PROVIDER_ERROR", "Research produced no sourced findings", "Research didn't produce any sourced findings, so the autopilot can't choose an audience responsibly. Retry research, then resume.");
  }
  return { kind: "advance", to: "select_audience" };
};

// ---------------------------------------------------------------------------
// select_audience (Wonder decision)
// ---------------------------------------------------------------------------

const ChooseAudience = z.object({
  candidates: z.array(z.object({ name: z.string().max(120), why: z.string().max(400) })).min(1).max(4).describe("The audiences you compared: three when the research supports it"),
  segmentId: z.string().max(128).optional().describe("Id of the chosen segment, if it is one of the listed segments"),
  audience: z.string().min(1).max(1000).describe("Who exactly this iteration targets"),
  rationale: z.string().min(1).max(2000),
  findingIds: z.array(z.string()).max(8).default([]),
});

const selectAudience: StageFn = async (env) => {
  const app = await loadAppContext(env.ws, env.appId);
  const segments = (await env.ws.collection("audienceSegments").list({ where: [["appId", "==", env.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 30 })).items;
  const findings = await findingsFor(env, 30);
  const memory = await retrieveMemory(env.p, { workspaceId: env.ctx.workspaceId, appId: env.appId, task: "growth_strategy", query: `audience ${env.ap.goal}`, jobId: env.ctx.job.id });
  const segIds = new Set(segments.map((s) => s.id));
  const { args, runId, citations } = await decide(env, {
    name: "select_audience",
    title: `Choose the audience for: ${env.ap.goal}`,
    instructions: "Compare three plausible audiences for this goal using the research (two only if the app and findings genuinely support no third), then choose ONE for this iteration with call choose_audience. Prefer audiences the app's real features serve and that the findings show are reachable now.",
    input: [
      `Goal: ${env.ap.goal}`,
      alwaysOnFocusLine(env),
      memory.items.length ? `Team memory:\n${memory.summary}` : "",
      `Audience segments (id | origin | name | pains):\n${segments.map((s) => `- ${s.id} | ${s.origin} | ${s.name} | ${s.painPoints.slice(0, 3).join("; ")}`).join("\n") || "(none)"}`,
      untrusted("research_findings", findingLines(findings) || "(no findings)", 14_000),
      untrusted("app_dna", dnaSummary(app), 8000),
    ]
      .filter(Boolean)
      .join("\n\n"),
    tool: {
      name: "choose_audience",
      description: "Record the chosen audience with rationale and the finding ids that support it.",
      schema: ChooseAudience,
      validate: (a) => (a.segmentId && !segIds.has(a.segmentId) ? `Unknown segmentId ${a.segmentId}` : citeCheck(findings, a.findingIds)),
      citations: (a) => citationsOf(findings, a.findingIds),
    },
  });
  env.set({ audience: { segmentId: args.segmentId, description: args.audience, rationale: args.rationale, findingIds: args.findingIds } });
  env.note(
    "decision",
    `Audience: ${args.audience}. Compared: ${args.candidates.map((c) => c.name).join(" vs ")}. Why: ${args.rationale}`,
    [...(args.segmentId ? [ref("audienceSegments", args.segmentId)] : []), ...args.findingIds.map((id) => ref("researchFindings", id)), ref("agentRuns", runId)],
    runId,
  );
  if (!citations.length && findings.length) env.note("observation", "Decision cited no external sources.");
  return { kind: "advance", to: "hypothesis" };
};

// ---------------------------------------------------------------------------
// hypothesis (Wonder decision → Experiment)
// ---------------------------------------------------------------------------

const hypothesis: StageFn = async (env) => {
  const n = env.ap.budget.variants;
  const findings = await findingsFor(env, 30);
  const app = await loadAppContext(env.ws, env.appId);
  const Schema = z.object({
    statement: z.string().min(1).max(1000).describe("Testable: 'For <audience>, <creative difference> will increase <metric> compared with <control>'"),
    primaryMetric: MetricName,
    variantLabels: z.array(z.string().min(1).max(160)).min(1).max(3).describe(`Exactly ${n} labels; the first is the control when there is more than one`),
    rationale: z.string().min(1).max(2000),
    findingIds: z.array(z.string()).max(8).default([]),
  });
  const { args, runId } = await decide(env, {
    name: "hypothesis",
    title: `What to test for ${env.ap.audience?.description ?? env.ap.goal}`,
    instructions: `Write ONE testable hypothesis for this iteration and call set_hypothesis. It must compare ${n} creative approach(es) (${n > 1 ? "control + challenger(s)" : "a single treatment"}) on a primary metric the founder can actually measure (views, clicks, installs, trials_started, new_subscriptions...). Do not promise results.`,
    input: [
      `Goal: ${env.ap.goal}`,
      alwaysOnFocusLine(env),
      `Chosen audience: ${env.ap.audience?.description ?? "(none)"}\nWhy: ${env.ap.audience?.rationale ?? ""}`,
      untrusted("research_findings", findingLines(findings) || "(no findings)", 12_000),
      untrusted("app_dna", dnaSummary(app), 6000),
    ]
      .filter(Boolean)
      .join("\n\n"),
    tool: {
      name: "set_hypothesis",
      description: "Record the hypothesis, primary metric and the labels of the creative variants to compare.",
      schema: Schema,
      validate: (a) => (a.variantLabels.length !== n ? `Provide exactly ${n} variant labels.` : citeCheck(findings, a.findingIds)),
      citations: (a) => citationsOf(findings, a.findingIds),
    },
  });
  const expId = hashId("exp", env.ap.id, env.iteration);
  await env.ws.collection("experiments").createIfAbsent(
    {
      id: expId,
      appId: env.appId,
      title: clip(`Autopilot #${env.iteration}: ${args.statement}`, 200),
      hypothesis: args.statement,
      baseline: { description: "No measured baseline is linked yet; results will come from the published variants.", observationIds: [] },
      variants: args.variantLabels.map((label, i) => ({ key: `v${i + 1}`, label, isControl: n > 1 && i === 0, publicationIds: [] })),
      primaryMetric: args.primaryMetric,
      secondaryMetrics: [],
      launchWindow: {},
      status: "proposed",
    },
    { actor: env.ctx.actor },
  );
  env.set({ hypothesis: { statement: args.statement, primaryMetric: args.primaryMetric, experimentId: expId } });
  env.note("decision", `What we’re testing: ${args.statement} Measured by: ${args.primaryMetric.replace(/_/g, " ")}. Versions: ${args.variantLabels.join(" vs ")}. Why: ${args.rationale}`, [ref("experiments", expId), ...args.findingIds.map((id) => ref("researchFindings", id)), ref("agentRuns", runId)], runId);
  return { kind: "advance", to: "plan_creative" };
};

// ---------------------------------------------------------------------------
// plan_creative (concepts → Wonder picks distinct variants)
// ---------------------------------------------------------------------------

const GOAL_BY_METRIC: Record<string, CampaignGoal> = {
  installs: "installs",
  clicks: "installs",
  trials_started: "subscriptions",
  new_subscriptions: "subscriptions",
  revenue: "subscriptions",
  active_subscriptions: "retention",
  views: "awareness",
  impressions: "awareness",
  reach: "awareness",
  likes: "engagement",
  comments: "engagement",
  shares: "engagement",
  saves: "engagement",
};

const planCreative: StageFn = async (env, step) => {
  const n = env.ap.budget.variants;
  if (step.phase !== "resume") {
    const gate = await env.budgetGate(env.estimate("campaign.generate_concepts"), "video ideas", step.approved);
    if (gate) return gate;
    const seg = env.ap.audience?.segmentId ? await env.ws.collection("audienceSegments").get(env.ap.audience.segmentId) : null;
    // Where the person said they post (quick setup / Settings) comes first; else the audience's channels.
    const chosen = (await env.ws.collection("apps").get(env.appId))?.postTo;
    const segChannels: Channel[] = seg?.channels.filter((c) => ["instagram", "tiktok", "youtube", "x", "linkedin", "threads", "facebook"].includes(c)).slice(0, 2) ?? [];
    const channels: Channel[] = chosen && !chosen.manual && chosen.channels.length ? chosen.channels.slice(0, 2) : segChannels;
    const campaignId = hashId("cpg", env.ap.id, env.iteration);
    const h = env.ap.hypothesis;
    await env.ws.collection("campaigns").createIfAbsent(
      {
        id: campaignId,
        appId: env.appId,
        name: truncateWords(`Autopilot ${env.iteration}: ${env.ap.audience?.description ?? env.ap.goal}`, 60),
        goal: GOAL_BY_METRIC[h?.primaryMetric ?? ""] ?? "awareness",
        request: clip(
          [`Goal: ${env.ap.goal}`, ...(env.ap.alwaysOn?.roundFocus ? [alwaysOnFocusLine(env)] : []), `Audience: ${env.ap.audience?.description ?? ""}`, `Hypothesis to test: ${h?.statement ?? ""}`, `Make strategically distinct short vertical videos so the variants test the hypothesis (primary metric: ${h?.primaryMetric ?? "views"}).`].join("\n"),
          4000,
        ),
        channels: channels.length ? channels : ["instagram", "tiktok"],
        // No length: each concept picks its own (30–60 s).
        deliverables: [{ kind: "short_video", aspectRatio: "9:16", count: n }],
        experimentId: h?.experimentId,
        status: "planning",
      },
      { actor: env.ctx.actor },
    );
    if (h?.experimentId) await env.ws.collection("experiments").update(h.experimentId, { campaignId }, { actor: env.ctx.actor });
    env.set({ campaignId });
    const job = await env.delegate("campaign.generate_concepts", { appId: env.appId, campaignId, count: Math.max(3, n) }, { key: "concepts", label: `Asked ${engine(env, "concepts.generate")} for video ideas (different angles, based on what we learned about your app, the research and past runs).`, credits: { operation: "campaign.generate_concepts" } });
    return { kind: "wait", jobIds: [job.id], tag: "plan_creative:concepts", reason: `${chooseTextModel(env.p, "concepts.generate").name} is coming up with ideas` };
  }
  const campaignId = env.ap.campaignId!;
  const variants = (await env.ws.collection("campaignVariants").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items.filter((v) => v.status !== "rejected");
  if (!variants.length) {
    const [job] = await delegated(env, "campaign.generate_concepts", (j) => (j.payload as { campaignId?: string }).campaignId === campaignId);
    throw fail("PROVIDER_ERROR", `No concepts were generated (${job ? jobError(job) : "missing job"})`, "No video ideas came back. Resume to try again.");
  }
  const want = Math.min(n, variants.length);
  const keys = Array.from({ length: want }, (_, i) => `v${i + 1}`);
  const byId = new Map(variants.map((v) => [v.id, v]));
  const Schema = z.object({
    picks: z.array(z.object({ variantId: z.string(), experimentKey: z.string() })).min(1).max(3),
    rationale: z.string().min(1).max(2000),
  });
  const exp = env.ap.hypothesis?.experimentId ? await env.ws.collection("experiments").get(env.ap.hypothesis.experimentId) : null;
  const { args, runId } = await decide(env, {
    name: "pick_variants",
    title: `Pick ${want} idea${want === 1 ? "" : "s"} to test`,
    instructions: `Pick exactly ${want} concept(s) with DIFFERENT angle types so the variants test the hypothesis, map each to an experiment variant key (${keys.join(", ")}${want > 1 ? "; v1 is the control" : ""}), then call pick_variants.`,
    input: [
      `Hypothesis: ${env.ap.hypothesis?.statement ?? ""}`,
      exp ? `Experiment variants: ${exp.variants.map((v) => `${v.key}${v.isControl ? " (control)" : ""}: ${v.label}`).join("; ")}` : "",
      `Concepts (id | angle | title | hook):\n${variants.map((v) => `- ${v.id} | ${v.angleType} | ${v.title} | ${clip(v.hook, 200)}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
    tool: {
      name: "pick_variants",
      description: "Record which concepts to produce and which experiment variant each represents.",
      schema: Schema,
      validate: (a) => {
        if (a.picks.length !== want) return `Pick exactly ${want} concept(s).`;
        if (a.picks.some((p) => !byId.has(p.variantId))) return "Unknown variantId; use ids from the concepts list.";
        if (new Set(a.picks.map((p) => p.variantId)).size !== want) return "Pick different concepts.";
        if (new Set(a.picks.map((p) => byId.get(p.variantId)!.angleType)).size !== want) return "Picked concepts must have different angle types.";
        const k = a.picks.map((p) => p.experimentKey).sort();
        if (JSON.stringify(k) !== JSON.stringify([...keys].sort())) return `Use each experiment key exactly once: ${keys.join(", ")}.`;
        return null;
      },
    },
  });
  for (const pick of args.picks) await env.ws.collection("campaignVariants").update(pick.variantId, { status: "selected" }, { actor: env.ctx.actor });
  await env.ws.collection("campaigns").update(campaignId, { selectedVariantIds: args.picks.map((p) => p.variantId) }, { actor: env.ctx.actor });
  if (exp) {
    const mapped = exp.variants.map((v) => {
      const pick = args.picks.find((p) => p.experimentKey === v.key);
      return pick ? { ...v, variantId: pick.variantId, label: clip(`${v.label} — ${byId.get(pick.variantId)!.title}`, 160) } : v;
    });
    await env.ws.collection("experiments").update(exp.id, { variants: mapped }, { actor: env.ctx.actor });
  }
  const ordered = [...args.picks].sort((a, b) => a.experimentKey.localeCompare(b.experimentKey)).map((p) => p.variantId);
  env.set({ variantIds: ordered });
  env.note("decision", `Chose ${args.picks.map((p) => `${p.experimentKey} = “${byId.get(p.variantId)!.title}” (${byId.get(p.variantId)!.angleType.replace(/_/g, " ")})`).join("; ")}. Why: ${args.rationale}`, [...ordered.map((id) => ref("campaignVariants", id)), ref("campaigns", campaignId), ref("agentRuns", runId)], runId);
  return { kind: "advance", to: "produce" };
};

// ---------------------------------------------------------------------------
// produce (storyboards → compositions)
// ---------------------------------------------------------------------------

const produce: StageFn = async (env, step) => {
  const campaignId = env.ap.campaignId!;
  if (step.phase !== "resume" || step.tag === "produce:screens") {
    // Storyboards pick screenshots by kind (raw app UI vs designed store image + its SAM cut-out).
    // When that check is still running (it starts after App DNA), wait for it: otherwise a store
    // image lands inside a device frame and fails verification.
    // Same for a walkthrough recording that is still being cut into clips (Muse Spark labels each shot).
    const screens = await screenJobsInFlight(env.ws, env.appId);
    if (screens.length) {
      const cutting = screens.some((j) => j.type === "media.analyze_recording");
      return { kind: "wait", jobIds: screens.map((j) => j.id), tag: "produce:screens", reason: cutting ? "Cutting your walkthrough recording into clips (Muse Spark)" : "Finding the real app screens in your screenshots (SAM 3.1)" };
    }
    // Videos only show the real app. With no screenshots or recordings yet (a website-only app, a TV
    // game), planning would fail: ask for footage instead and pick up from here once it's added.
    if (!(await hasRealAppMedia(env.ws, env.appId))) {
      return env.checkpoint(
        "agent_continue",
        "Your videos show your real app, but MuseLaunch has no screenshots or screen recordings of it yet. Add a screen recording (or a few screenshots) on the Videos page, then press Continue to make the videos with them. Pause stops here.",
        undefined,
        "produce:media",
        "Add a screen recording or screenshots of your app",
      );
    }
    const per =env.estimate("storyboard.generate") + env.estimate("composition.build") + env.estimate("render.preview");
    // Budget approvals come back as enter/resume; another decision (e.g. "produce:media") isn't one.
    const gate = await env.budgetGate(per * env.ap.variantIds.length, `planning and making ${env.ap.variantIds.length} video${env.ap.variantIds.length === 1 ? "" : "s"}`, step.approved && step.phase !== "approved");
    if (gate) return gate;
    const jobs: Job[] = [];
    for (const variantId of env.ap.variantIds) {
      jobs.push(
        // Length: the concept's own (30–60 s, chosen with the concept).
        await env.delegate("storyboard.generate", { appId: env.appId, campaignId, variantId, aspectRatio: "9:16" }, { key: `storyboard:${variantId}`, label: `Asked ${engine(env, "storyboard.generate")} to plan a video (real screenshots for demo scenes); the plan becomes an editable HyperFrames video.`, credits: { operation: "storyboard.generate" } }),
      );
    }
    return { kind: "wait", jobIds: jobs.map((j) => j.id), tag: "produce:storyboards", reason: `Planning ${jobs.length} video${jobs.length === 1 ? "" : "s"}` };
  }
  const storyboards = await delegated(env, "storyboard.generate", (j) => (j.payload as { campaignId?: string }).campaignId === campaignId);
  // storyboard → storyboard.resolve_media (lifestyle b-roll) → composition.build
  const mediaIds = storyboards.flatMap((j) => {
    const d = j.output?.data as { mediaJobId?: string } | undefined;
    return j.status === "succeeded" && d?.mediaJobId ? [d.mediaJobId] : [];
  });
  const media = await env.ws.collection("jobs").getMany(mediaIds);
  const findingMedia = media.filter((j) => !isTerminalJob(j));
  if (findingMedia.length) return { kind: "wait", jobIds: findingMedia.map((j) => j.id), tag: "produce:media", reason: `Finding lifestyle b-roll for ${findingMedia.length} video(s)` };
  const builds = [...storyboards, ...media].flatMap((j) => {
    const d = j.output?.data as { buildJobId?: string } | undefined;
    return j.status === "succeeded" && d?.buildJobId ? [d.buildJobId] : [];
  });
  const buildJobs = await env.ws.collection("jobs").getMany(builds);
  const pending = buildJobs.filter((j) => !isTerminalJob(j));
  if (pending.length) return { kind: "wait", jobIds: pending.map((j) => j.id), tag: "produce:builds", reason: `Building ${pending.length} editable video(s)` };
  const failedSb = storyboards.filter((j) => j.status !== "succeeded");
  for (const j of failedSb) env.note("error", `Planning a video failed: ${jobError(j)}`, [ref("jobs", j.id)]);
  for (const j of media.filter((m) => m.status !== "succeeded")) env.note("error", `Finding b-roll failed, so that video wasn't built: ${jobError(j)}`, [ref("jobs", j.id)]);
  for (const j of buildJobs.filter((b) => b.status !== "succeeded")) env.note("error", `Building a video failed: ${jobError(j)}`, [ref("jobs", j.id)]);
  const ids = storyboards.flatMap((j) => {
    const d = j.output?.data as { compositionId?: string } | undefined;
    return d?.compositionId ? [d.compositionId] : [];
  });
  const comps = await env.ws.collection("compositions").getMany(ids);
  if (!comps.length) throw fail("PROVIDER_ERROR", "No videos could be built", "None of the videos could be built from their plans. Check your app’s screenshots and media, then resume.");
  env.set({ compositionIds: comps.map((c) => c.id) });
  env.note("observation", `Built ${comps.length} editable video${comps.length === 1 ? "" : "s"} from plans that use your real app media.`, comps.map((c) => ref("compositions", c.id)));
  return { kind: "advance", to: "verify" };
};

// ---------------------------------------------------------------------------
// verify (lint + claim validation + Brand Guardian; fix rounds via the Guardian's suggested fixes
// or scene-scoped composition.edit; never overrides the Guardian)
// ---------------------------------------------------------------------------

/** Highest automatic fix round started in this iteration (0 = none). */
const fixRounds = (env: LoopEnv) =>
  Math.max(0, ...env.fullLog.filter((e) => e.stage === "verify" && e.kind === "action" && e.summary.includes(`(iteration ${env.iteration})`)).map((e) => Number(e.summary.match(/^Fix round (\d+)/)?.[1] ?? 0)));

function textLayers(doc: CompositionDoc): { sceneId: string; id: string; text: string }[] {
  return doc.scenes.flatMap((s) => s.layers.flatMap((l) => (l.type === "text" && !l.hidden ? [{ sceneId: s.id, id: l.id, text: l.text }] : [])));
}

/** Blocking Guardian findings nobody dismissed (dismissals are human decisions) or fixed yet. */
const openBlocks = (r: BrandReview): BrandFinding[] => r.findings.filter((f) => f.severity === "block" && f.resolution?.state !== "dismissed" && f.resolution?.state !== "applied");

/** Newest review of this exact composition version (terminal ones first). */
async function reviewOf(env: LoopEnv, compositionId: string, version: number): Promise<BrandReview | undefined> {
  const all = await reviewsFor(env.ws, { entity: "compositions", id: compositionId }, { version, contentHash: "" });
  return all.find(isTerminalReview) ?? all[0];
}

interface Blocking {
  compositionId: string;
  title: string;
  version: number;
  /** For the AI fix: exact scene and layer ids. */
  issues: string[];
  /** For people: scene numbers and plain words. */
  plain: string[];
  sceneIds: string[];
  review?: BrandReview;
}

/** "Scene 3: " for a scene id in this doc ("" when unknown or absent). */
function sceneLabel(doc: CompositionDoc, sceneId: string | undefined): string {
  const i = sceneId ? doc.scenes.findIndex((s) => s.id === sceneId) : -1;
  return i >= 0 ? `Scene ${i + 1}: ` : "";
}

const verify: StageFn = async (env, step) => {
  const comps = await env.ws.collection("compositions").getMany(env.ap.compositionIds);
  if (step.phase === "approved" && step.tag === "verify:unresolved") {
    env.note("checkpoint", "You chose to continue. Videos that still have a problem are left out of the final videos unless someone goes ahead with a reason in the brand check.");
    return { kind: "advance", to: "render" };
  }
  if (step.phase === "resume" && step.tag === "verify:fix") {
    for (const c of comps) {
      const patches = await env.ws.collection("compositionPatches").getMany([hashId("pch", env.ap.id, env.iteration, c.id, fixRounds(env))]);
      for (const pt of patches) env.note("observation", `Fix for “${c.title}”: ${pt.status}${pt.resultVersion ? ` → version ${pt.resultVersion}` : ""}. ${clip(pt.summary, 200)}${pt.validationErrors.length ? ` Issues: ${pt.validationErrors.slice(0, 2).join("; ")}` : ""}`, [ref("compositionPatches", pt.id), ref("compositions", c.id)]);
    }
    return { kind: "advance", to: "verify" };
  }
  if (step.phase !== "resume") {
    const gate = await env.budgetGate(env.estimate("brand.review") * comps.length, "brand checks", step.approved);
    if (gate) return gate;
    const waitIds: string[] = [];
    const reviewIds: string[] = [];
    for (const c of comps) {
      const { review, job, reused } = await requestBrandReview(env.p, env.ctx.workspaceId, {
        subject: { entity: "compositions", id: c.id },
        version: c.currentVersion,
        actor: env.ctx.requestedBy,
        parentJobId: env.ctx.job.id,
        idempotencyKey: `autopilot:${env.ap.id}:verify:${c.id}:v${c.currentVersion}`,
      });
      reviewIds.push(review.id);
      if (job && !isTerminalJob(job)) waitIds.push(job.id);
      if (!env.fullLog.some((e) => e.kind === "action" && e.refs.some((r) => r.entity === "brandReviews" && r.id === review.id)))
        env.note("action", reused ? `Using the existing brand check of “${c.title}” v${c.currentVersion}.` : `Asked for a brand check of “${c.title}” v${c.currentVersion}.`, [ref("brandReviews", review.id), ...(job && !reused ? [ref("jobs", job.id)] : [])]);
    }
    env.set({ reviewIds: [...new Set([...env.ap.reviewIds, ...reviewIds])] });
    return { kind: "wait", jobIds: waitIds, tag: "verify:reviews", reason: `Checking ${comps.length} video${comps.length === 1 ? "" : "s"}: layout, facts and brand` };
  }

  // resume: verify:reviews
  const blocking: Blocking[] = [];
  for (const c of comps) {
    const v = await getVersion(env.ws, c.id, c.currentVersion);
    const doc = v.doc;
    // Every asset the doc references (backgrounds, devices, effects and audio tracks too): the live
    // pipeline run flagged its own music and sound effects as "missing" when only layers were loaded.
    const assets = await env.ws.collection("mediaAssets").getMany(collectAssetRefs(doc).assetIds);
    const claimIds = [...new Set(doc.scenes.flatMap((s) => s.layers.flatMap((l) => (l.type === "text" ? l.claimIds : []))))];
    const claims = await env.ws.collection("claims").getMany(claimIds);
    const lint = lintDoc(doc, { assets: Object.fromEntries(assets.map((a) => [a.id, a])), claims: Object.fromEntries(claims.map((x) => [x.id, x])) });
    const lintErrors = lint.filter((i) => i.level === "error");
    const texts = textLayers(doc);
    const claimCheck = await validateClaims(env.p, { workspaceId: env.ctx.workspaceId, appId: env.appId, texts: texts.map((t) => ({ id: t.id, text: t.text })), jobId: env.ctx.job.id });
    const review = await reviewOf(env, c.id, v.version);
    const reviewDone = review && isTerminalReview(review);
    const blocks = reviewDone ? openBlocks(review!) : [];
    const warns = reviewDone ? review!.findings.filter((f) => f.severity === "warn" && f.resolution?.state !== "dismissed") : [];
    const engine = review?.reviewer.engine === "glimmer" ? "Muse Glimmer (self-hosted)" : "rules";
    const reviewText = reviewDone
      ? `Brand check (${engine}): ${review!.status}${blocks.length ? `, ${blocks.length} blocking` : ""}${warns.length ? `, ${warns.length} warning(s)` : ""}`
      : `Brand check unavailable (${review?.status ?? "no review"}${review?.error ? `: ${clip(review.error, 120)}` : ""}) — not counted as a pass; it runs again before the final video`;
    env.note(
      "verification",
      `“${c.title}” v${v.version}: layout ${lintErrors.length ? `${lintErrors.length} problem(s)` : "ok"}${lint.length - lintErrors.length ? ` (${lint.length - lintErrors.length} note(s))` : ""} · facts ${claimCheck.ok ? "ok" : `${claimCheck.issues.length} issue(s)`} · ${reviewText}.`,
      [ref("compositions", c.id), ...(review ? [ref("brandReviews", review.id)] : [])],
    );
    // For the AI fix (exact ids) …
    const issues = [
      ...lintErrors.map((i) => `Lint: ${i.message}${i.sceneId ? ` (scene ${i.sceneId})` : ""}`),
      ...claimCheck.issues.map((i) => `Claim in layer ${i.id}: ${i.issue}`),
      ...blocks.map((f) => `Brand Guardian: ${f.message}${f.suggestion ? ` Suggestion: ${f.suggestion}` : ""}`),
    ];
    // … and for people (scene numbers, plain words).
    const layerScene = (layerId: string) => texts.find((t) => t.id === layerId)?.sceneId;
    const plain = [
      ...lintErrors.map((i) => `${sceneLabel(doc, i.sceneId)}${i.message}`),
      ...claimCheck.issues.map((i) => `${sceneLabel(doc, layerScene(i.id))}text says more than the confirmed facts (${i.issue})`),
      ...blocks.map((f) => `${sceneLabel(doc, f.location?.sceneId)}brand check: ${f.message}${f.suggestion ? ` Try: ${f.suggestion}` : ""}`),
    ];
    if (issues.length) {
      const sceneIds = [
        ...new Set([
          ...lintErrors.flatMap((i) => (i.sceneId ? [i.sceneId] : [])),
          ...claimCheck.issues.flatMap((i) => texts.filter((t) => t.id === i.id).map((t) => t.sceneId)),
          ...blocks.flatMap((f) => (f.location?.sceneId ? [f.location.sceneId] : [])),
        ]),
      ].filter((id) => doc.scenes.some((s) => s.id === id));
      blocking.push({ compositionId: c.id, title: c.title, version: v.version, issues, plain, sceneIds, review: reviewDone ? review : undefined });
    }
  }
  if (!blocking.length) return { kind: "advance", to: "render" };
  const round = fixRounds(env);
  if (round >= MAX_FIX_ROUNDS) {
    const one = blocking.length === 1;
    const names = blocking.map((b) => `“${clip(b.title, 60)}”`).join(", ");
    const shown = blocking.flatMap((b) => b.plain.map((x) => (one ? x : `${clip(b.title, 40)}, ${x[0]!.toLowerCase()}${x.slice(1)}`)));
    const more = shown.length > 3 ? ` (+${shown.length - 3} more)` : "";
    return env.checkpoint(
      "agent_continue",
      `We tried ${round} automatic fix${round === 1 ? "" : "es"}, but ${names} still ${one ? "has a problem" : "have problems"}: ${shown.slice(0, 3).join(" · ")}${more}. ` +
        `Open ${one ? "it" : "them"} in the editor to fix ${one ? "it" : "them"}, or go ahead with a reason in the brand check. ` +
        `Continue finishes the videos; any still flagged are left out. Pause stops here.`,
      undefined,
      "verify:unresolved",
      one ? `“${clip(blocking[0]!.title, 80)}” needs a look before it’s finished` : `${blocking.length} videos need a look before they’re finished`,
    );
  }
  const gate = await env.budgetGate(env.estimate("composition.edit") * blocking.length, "automatic fixes", step.approved);
  if (gate) return gate;
  const label = (b: Blocking, how: string) => `Fix round ${round + 1} (iteration ${env.iteration}): ${how} “${b.title}”`;
  const waitIds: string[] = [];
  for (const b of blocking) {
    // 1) The Brand Guardian's own validated fix (suggestedOps) → new version + re-review.
    const fixable = b.review && b.review.subjectVersion === b.version ? openBlocks(b.review).find((f) => f.suggestedOps?.length) : undefined;
    if (fixable) {
      try {
        const out = await applyFinding(env.p, env.ctx.workspaceId, { reviewId: b.review!.id, findingId: fixable.id, actor: env.ctx.requestedBy, automatic: true });
        if (out.reReview.job) waitIds.push(out.reReview.job.id);
        env.note("action", `${label(b, "applied the brand check’s suggested fix to")} (${clip(fixable.suggestion ?? fixable.message, 160)}) → v${out.version.version}; re-reviewing.`, [
          ref("compositions", b.compositionId),
          ref("brandReviews", b.review!.id),
          ...(out.reReview.job ? [ref("jobs", out.reReview.job.id)] : []),
        ]);
        continue;
      } catch (raw) {
        const e = toAppError(raw);
        env.note("observation", `The brand check’s suggested fix for “${b.title}” couldn't be applied (${e.opts.userMessage ?? e.message}); asking ${engine(env, "composition.edit.scoped")} for a scene-scoped fix instead.`, [ref("brandReviews", b.review!.id)]);
      }
    }
    // 2) Scene-scoped AI edit of exactly the flagged scenes.
    const patchId = hashId("pch", env.ap.id, env.iteration, b.compositionId, round + 1);
    const instruction = clip(`Fix these verification issues without changing anything else: ${b.issues.join(" | ")}`, 2000);
    await env.ws.collection("compositionPatches").createIfAbsent(
      { id: patchId, compositionId: b.compositionId, baseVersion: b.version, ops: [], summary: "Generating fix…", source: "ai", instruction, affectedSceneIds: b.sceneIds, status: "proposed" },
      { actor: env.ctx.actor },
    );
    const job = await env.delegate(
      "composition.edit",
      { appId: env.appId, compositionId: b.compositionId, baseVersion: b.version, instruction, sceneIds: b.sceneIds, patchId, autoApply: true },
      { key: `fix:${b.compositionId}:r${round + 1}`, label: `${label(b, `asked ${engine(env, "composition.edit.scoped")} for a scene-scoped fix of ${b.issues.length} issue(s) in`)}.`, credits: { operation: "composition.edit" } },
    );
    waitIds.push(job.id);
  }
  return { kind: "wait", jobIds: waitIds, tag: "verify:fix", reason: `Applying fix round ${round + 1}` };
};

// ---------------------------------------------------------------------------
// render (Brand Guardian gate per video; checkpoint unless within auto-approve)
// ---------------------------------------------------------------------------

interface RenderPlan {
  id: string;
  title: string;
  version: number;
  durationSec: number;
  credits: number;
}

/**
 * Videos that may be rendered: no lint errors, and the Brand Guardian gate passes for the exact
 * version. A blocked review is only rendered when a person already overrode it for a final render
 * (the loop itself never overrides).
 */
export async function renderable(env: LoopEnv, comps: Composition[]): Promise<{ plan: RenderPlan[]; excluded: { compositionId: string; why: string }[] }> {
  const plan: RenderPlan[] = [];
  const excluded: { compositionId: string; why: string }[] = [];
  for (const c of comps) {
    const v = await getVersion(env.ws, c.id, c.currentVersion);
    const assets = await env.ws.collection("mediaAssets").getMany(collectAssetRefs(v.doc).assetIds);
    const lintErrors = lintDoc(v.doc, { assets: Object.fromEntries(assets.map((a) => [a.id, a])) }).filter((i) => i.level === "error" && /missing asset/.test(i.message));
    if (lintErrors.length) {
      excluded.push({ compositionId: c.id, why: `“${c.title}” v${v.version} has missing media (${clip(lintErrors[0]!.message, 120)})` });
      continue;
    }
    try {
      await brandGate(env.p, env.ctx.workspaceId, { subject: { entity: "compositions", id: c.id }, version: v.version, actor: env.ctx.requestedBy, canOverride: false, action: "render_final" });
    } catch (raw) {
      const e = toAppError(raw);
      const reason = (e.opts.details as { reason?: string } | undefined)?.reason;
      if (reason === "brand_review_running") throw new AppError("CONFLICT", "Brand Guardian is still reviewing a video", { retryable: true });
      if (e.code !== "APPROVAL_REQUIRED") throw raw;
      const review = await reviewOf(env, c.id, v.version);
      if (!review?.overrides.some((o) => o.action === "render_final")) {
        excluded.push({ compositionId: c.id, why: `the brand check flags “${c.title}” v${v.version} (${clip(e.message.replace(/^Brand Guardian blocked this final render:\s*/, ""), 160)})` });
        continue;
      }
      env.note("observation", `“${c.title}” v${v.version}: finishing it because ${review.overrides.find((o) => o.action === "render_final")!.by} went ahead past the brand check with a reason.`, [ref("brandReviews", review.id)]);
    }
    const durationSec = Math.round(totalDuration(v.doc));
    plan.push({ id: c.id, title: c.title, version: v.version, durationSec, credits: env.estimate("render.final", { durationSec }) });
  }
  return { plan, excluded };
}

const render: StageFn = async (env, step) => {
  // After the final renders Spark watches them (watch.ts): one fix round + re-render for blockers.
  if (step.phase !== "enter" && isWatchTag(step.tag)) return watchStep(env, step, renderable);
  const comps = await env.ws.collection("compositions").getMany(env.ap.compositionIds);
  if (step.phase === "resume" && step.tag === "render") {
    const jobs = await delegated(env, "render.final", (j) => env.ap.compositionIds.includes((j.payload as { compositionId: string }).compositionId));
    const latest = new Map<string, Job>();
    for (const j of jobs) latest.set((j.payload as { compositionId: string }).compositionId, j);
    const ok = [...latest.values()].filter((j) => j.status === "succeeded");
    for (const j of [...latest.values()].filter((x) => x.status !== "succeeded")) env.note("error", `Making the final video failed: ${jobError(j)}`, [ref("jobs", j.id)]);
    if (!ok.length) throw fail("PROVIDER_ERROR", "No final render succeeded", "The final videos couldn’t be made, so nothing can be scheduled yet. Resume to try again.");
    const rendered = `Finished ${ok.length} MP4${ok.length === 1 ? "" : "s"} with HyperFrames.`;
    const refs = ok.map((j) => ref("compositions", (j.payload as { compositionId: string }).compositionId));
    // Re-entered after a budget approval for Spark's reviews: don't log the renders twice.
    if (!env.fullLog.some((e) => e.summary === rendered && e.refs.map((r) => r.id).join() === refs.map((r) => r.id).join())) env.note("observation", rendered, refs);
    return watchRenders(env, step);
  }
  const { plan, excluded } = await renderable(env, comps);
  for (const x of excluded) {
    const summary = `Left out of the final videos: ${x.why}. Fix it in the editor (or go ahead with a reason) to include it.`;
    if (!env.fullLog.some((e) => e.summary === summary && e.refs.some((r) => r.id === x.compositionId))) env.note("verification", summary, [ref("compositions", x.compositionId)]);
  }
  if (!plan.length) throw fail("CONFLICT", "No video passed the Brand Guardian render gate", "The brand check flags every video in this round. Fix them in the editor (or go ahead with a reason), then resume.");
  const total = plan.reduce((n, x) => n + x.credits, 0);
  const renderApproved = step.tag === "render:approve";
  const gate = await env.budgetGate(total, `finishing ${plan.length} video${plan.length === 1 ? "" : "s"}`, step.approved && step.phase !== "approved");
  if (gate) return gate;
  if (!renderApproved && total > env.ap.budget.autoApproveCredits) {
    return env.checkpoint("spend", `Finish ${plan.length} video${plan.length === 1 ? "" : "s"} for about ${total} credits? Autopilot only spends up to ${env.ap.budget.autoApproveCredits} credits at a time without asking.`, total, "render:approve", `Finishing the videos needs your OK (about ${total} credits)`);
  }
  if (renderApproved) env.note("checkpoint", `You approved finishing the videos (about ${total} credits).`);
  else env.note("decision", `Finishing the videos without asking: about ${total} credits is within the ${env.ap.budget.autoApproveCredits}-credit limit you allow.`);
  const jobs: Job[] = [];
  for (const x of plan) {
    jobs.push(await env.delegate("render.final", { appId: env.appId, compositionId: x.id, version: x.version, format: "mp4" }, { key: `render:${x.id}:v${x.version}`, label: `Final video of “${x.title}” v${x.version} (${x.durationSec}s), brand check passed.`, credits: { operation: "render.final", params: { durationSec: x.durationSec } } }));
  }
  return { kind: "wait", jobIds: jobs.map((j) => j.id), tag: "render", reason: `Rendering ${jobs.length} final video(s)` };
};

// ---------------------------------------------------------------------------
// schedule (draft posts; every post needs the user's approval)
// ---------------------------------------------------------------------------

const schedule: StageFn = async (env, step) => {
  const campaignId = env.ap.campaignId!;
  const campaign = await env.ws.collection("campaigns").getOrThrow(campaignId);
  // Read fresh: "Where do you post?" is often answered while the run is already going.
  const accounts = (await env.ws.collection("connectedAccounts").list({ limit: 200 })).items;
  const target = postingTarget(await env.ws.collection("apps").get(env.appId), campaign.channels, accounts);
  let channel = target.channel;
  if (step.phase !== "resume") {
    const gate = await env.budgetGate(env.estimate("copy.generate") * env.ap.variantIds.length, "post copy", step.approved);
    if (gate) return gate;
    const jobs: Job[] = [];
    for (const variantId of env.ap.variantIds) {
      jobs.push(await env.delegate("copy.generate", { appId: env.appId, campaignId, variantId, channels: [channel] }, { key: `copy:${variantId}`, label: `Delegated ${channel} copy to ${engine(env, "copy.generate")} (claim-validated).`, credits: { operation: "copy.generate" } }));
    }
    return { kind: "wait", jobIds: jobs.map((j) => j.id), tag: "schedule:copy", reason: "Writing post copy" };
  }
  const renders = await delegated(env, "render.final", (j) => j.status === "succeeded" && env.ap.compositionIds.includes((j.payload as { compositionId: string }).compositionId));
  // Newest rendered version per video (a re-render after Spark's fix supersedes the first render).
  const rendered = new Map<string, number>();
  for (const j of renders) {
    const { compositionId, version } = j.payload as { compositionId: string; version: number };
    rendered.set(compositionId, Math.max(rendered.get(compositionId) ?? 0, version));
  }
  const comps = (await env.ws.collection("compositions").getMany([...rendered.keys()])).filter((c) => c.campaignId === campaignId);
  const packs = (await env.ws.collection("copyPacks").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 })).items;
  // The copy was written for the channel picked before it; if "Where do you post?" changed since, stay with that one.
  const written = packs.filter((x) => x.variantId && env.ap.variantIds.includes(x.variantId));
  if (written.length && !written.some((x) => x.channel === channel)) channel = written[0]!.channel;
  const accountId = channel === target.channel ? target.accountId : undefined;
  const existing = (await env.ws.collection("scheduledPosts").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 })).items;
  const tz = (await env.p.db.top("workspaces").get(env.ctx.workspaceId))?.settings.defaultTimezone ?? "UTC";
  // Always on: spread over the next free posting days at the app's pace (labelled by where the time comes from).
  const spread = env.ap.alwaysOn ? await alwaysOnTimes(env, channel, Math.max(1, comps.length), tz) : null;
  const times = spread ?? (await suggestTimes(env.ws, env.appId, { channel, count: Math.max(1, comps.length) }, tz, nowMs(env.p)));
  const postIds: string[] = [];
  const refs: EntityRef[] = [];
  // Each post gets its own tracked link to the app's store page / site, tagged with the experiment
  // variant, so clicks (and installs, where the store passes them on) are attributed per variant.
  const app = await env.ws.collection("apps").get(env.appId);
  const destination = app?.storeUrls.ios ? "ios" : app?.storeUrls.android ? "android" : app?.websiteUrl ? "website" : undefined;
  const expBefore = env.ap.hypothesis?.experimentId ? await env.ws.collection("experiments").get(env.ap.hypothesis.experimentId) : null;
  for (const [i, c] of comps.entries()) {
    const already = existing.find((x) => x.compositionId === c.id && x.status !== "cancelled");
    if (already) {
      postIds.push(already.id);
      continue;
    }
    const pack = packs.find((x) => x.variantId === c.variantId && x.channel === channel);
    const slot = times.items[i];
    let trackingLinkId: string | undefined;
    if (destination) {
      try {
        const key = expBefore?.variants.find((v) => v.variantId === c.variantId)?.key;
        const link = await createTrackedLink(env.p, env.ctx.workspaceId, campaignId, { destination, confirmExternalDestination: false, channel, utm: { source: channel, medium: "social", content: key ?? c.variantId } }, env.ctx.actor);
        trackingLinkId = link.id;
        refs.push(ref("attributionLinks", link.id));
      } catch (raw) {
        env.note("observation", `No tracked link for “${c.title}”: ${toAppError(raw).opts.userMessage ?? toAppError(raw).message}`);
      }
    }
    try {
      const { post } = await createPost(
        env.p,
        env.ctx.workspaceId,
        env.appId,
        {
          campaignId,
          variantId: c.variantId,
          compositionId: c.id,
          compositionVersion: rendered.get(c.id),
          copyPackId: pack?.id,
          caption: pack ? undefined : c.title,
          // YouTube needs a title: the video's own when the copy has none.
          title: channel === "youtube" && !pack?.items.some((i) => i.kind === "title") ? clip(c.title, 100) : undefined,
          channel,
          accountId,
          scheduledAt: slot?.at,
          suggestedTimeReason: slot?.reason,
          visibility: "public",
          trackingLinkId,
        },
        env.ctx.actor,
      );
      postIds.push(post.id);
      refs.push(ref("scheduledPosts", post.id));
      try {
        // Same Brand Guardian gate as the approval route (never overridden by the loop).
        await brandGate(env.p, env.ctx.workspaceId, { subject: { entity: "scheduledPosts", id: post.id }, actor: env.ctx.requestedBy, canOverride: false, action: "request_approval" });
        const { approval } = await requestPostApproval(env.p, env.ctx.workspaceId, post.id, env.ctx.actor, { notify: false });
        refs.push(ref("approvals", approval.id));
      } catch (raw) {
        env.note("observation", `Post for “${c.title}” saved as a draft; approval can't be requested yet: ${toAppError(raw).opts.userMessage ?? toAppError(raw).message}`, [ref("scheduledPosts", post.id)]);
      }
    } catch (raw) {
      env.note("error", `Couldn't draft a post for “${c.title}”: ${toAppError(raw).opts.userMessage ?? toAppError(raw).message}`, [ref("compositions", c.id)]);
    }
  }
  env.set({ scheduledPostIds: [...new Set([...env.ap.scheduledPostIds, ...postIds])] });
  // One push for the whole batch ("2 posts are ready to review") to the linked phones of who can schedule them.
  if (postIds.length) await notifyPostsReady(env.p, env.ctx.workspaceId, env.appId);
  const exp = env.ap.hypothesis?.experimentId ? await env.ws.collection("experiments").get(env.ap.hypothesis.experimentId) : null;
  const starts = times.items.slice(0, comps.length).map((t) => Date.parse(t.at));
  const start = starts.length ? Math.min(...starts) : nowMs(env.p);
  if (exp) await env.ws.collection("experiments").update(exp.id, { launchWindow: { start: new Date(start).toISOString(), end: new Date(start + MEASURE_DAYS * DAY_MS).toISOString() } }, { actor: env.ctx.actor });
  env.note(
    "action",
    `Drafted ${postIds.length} ${channel} post(s) with suggested times (${"spreadLabel" in times ? times.spreadLabel : times.basis === "your_results" ? "from your own results" : "general heuristic"}). Each post is awaiting your approval — nothing is published without you.${channel === target.channel && target.note ? ` ${target.note}` : ""}`,
    [...refs, ...(exp ? [ref("experiments", exp.id)] : [])],
  );
  return { kind: "advance", to: "measure" };
};

// ---------------------------------------------------------------------------
// measure (sleep through the launch window; honest about missing data)
// ---------------------------------------------------------------------------

const measure: StageFn = async (env, step) => {
  // Always on: go on as soon as the coming week isn't covered; otherwise wait for the next post to go out.
  const always = await alwaysOnMeasure(env);
  if (always) return always;
  const exp = env.ap.hypothesis?.experimentId ? await env.ws.collection("experiments").get(env.ap.hypothesis.experimentId) : null;
  if (step.phase !== "resume") {
    const until = exp?.launchWindow.end ? Date.parse(exp.launchWindow.end) : nowMs(env.p) + MEASURE_DAYS * DAY_MS;
    if (until > nowMs(env.p)) {
      const when = new Date(until).toISOString();
      env.note("action", `Measuring until ${when.slice(0, 10)}: results are read from your connected analytics and imports when the test window ends.`);
      return { kind: "sleep", until: when, tag: "measure", reason: `Waiting for results until ${when.slice(0, 10)}` };
    }
  }
  const posts = await env.ws.collection("scheduledPosts").getMany(env.ap.scheduledPostIds);
  const live = posts.filter((x) => x.status === "published" || x.status === "manually_posted").length;
  const pending = posts.filter((x) => ["draft", "awaiting_approval", "scheduled", "manual_post_needed"].includes(x.status)).length;
  const data = exp ? await gatherExperimentData(env.p, env.ctx.workspaceId, exp) : { observations: [] };
  if (!data.observations.length) {
    env.note(
      "observation",
      `No measured results are linked to this test yet (${live} of ${posts.length} post(s) published, ${pending} still waiting). Connect analytics (RevenueCat, App Store, social) or import a CSV; nothing is estimated or invented.`,
      exp ? [ref("experiments", exp.id)] : [],
    );
  } else {
    const sources = [...new Set(data.observations.map((o) => o.source))];
    env.note("observation", `${data.observations.length} measured result(s) linked to the test (sources: ${sources.join(", ")}).`, data.observations.slice(0, 10).map((o) => ref("metricObservations", o.id)));
  }
  return { kind: "advance", to: "learn" };
};

// ---------------------------------------------------------------------------
// learn (analysis → recommendations → memory → next iteration)
// ---------------------------------------------------------------------------

const learn: StageFn = async (env, step) => {
  // Always on, waiting for its weekly allowance or for credits: check again (no second analysis).
  if (step.tag === NEXT_ROUND_TAG) return (await alwaysOnNextRound(env)) ?? { kind: "done", summary: "Always on was turned off." };
  const expId = env.ap.hypothesis?.experimentId;
  if (step.phase !== "resume") {
    const gate = await env.budgetGate(env.estimate("experiment.analyze") + env.estimate("recommendations.generate"), "reading results and next steps", step.approved);
    if (gate) return gate;
    const jobs: Job[] = [];
    if (expId) jobs.push(await env.delegate("experiment.analyze", { appId: env.appId, experimentId: expId }, { key: "analyze", label: "Asked for a read of the test results (measured statements only; guesses kept separate).", credits: { operation: "experiment.analyze" } }));
    jobs.push(await env.delegate("recommendations.generate", { appId: env.appId }, { key: "recommend", label: "Asked for next-step recommendations based on measured data and memory.", credits: { operation: "recommendations.generate" } }));
    return { kind: "wait", jobIds: jobs.map((j) => j.id), tag: "learn", reason: "Analysing results" };
  }
  const [analyze] = (await delegated(env, "experiment.analyze", (j) => (j.payload as { experimentId?: string }).experimentId === expId)).slice(-1);
  const recJobs = await delegated(env, "recommendations.generate");
  const recJob = recJobs[recJobs.length - 1];
  const resultId = analyze?.output?.refs.find((r) => r.entity === "experimentResults")?.id;
  const result = resultId ? await env.ws.collection("experimentResults").get(resultId) : null;
  const recIds = recJob?.output?.refs.filter((r) => r.entity === "recommendations").map((r) => r.id) ?? [];
  const recs = await env.ws.collection("recommendations").getMany(recIds);
  env.set({ recommendationIds: recIds });
  if (result) {
    env.note("observation", `What the results say (${result.confidence.replace(/_/g, " ")}): ${clip(result.summary, 500)}`, [ref("experimentResults", result.id), ...(expId ? [ref("experiments", expId)] : [])]);
    if (result.measured.length) {
      const prefs = await ingestMemory(env.p, env.ctx.workspaceId, ref("experimentResults", result.id), env.ctx.actor);
      env.note("action", `Remembered ${prefs.length} measured lesson(s) for future campaigns.`, prefs.map((x) => ref("brandPreferences", x.id)));
    } else {
      env.note("observation", "No lesson stored: the results had no measured statements yet, so nothing was learned (guesses are never stored as lessons).");
    }
  } else if (analyze) {
    env.note("error", `Reading the test results didn't complete: ${jobError(analyze)}`, [ref("jobs", analyze.id)]);
  }
  if (recs.length) env.note("observation", `Next steps: ${recs.map((r) => r.title).join(" · ")}`, recs.map((r) => ref("recommendations", r.id)));
  else if (recJob && recJob.status !== "succeeded") env.note("error", `Next steps didn't complete: ${jobError(recJob)}`, [ref("jobs", recJob.id)]);

  // Always on: no round cap; the next round is paced by the weekly allowance instead (always-on-loop.ts).
  const always = Boolean(env.ap.alwaysOn);
  if (!always && env.iteration >= env.ap.budget.maxIterations) return { kind: "done", summary: `Finished ${env.iteration} round${env.iteration === 1 ? "" : "s"}.` };
  const spent = await env.spent();
  if (!always && spent >= env.ap.budget.maxCredits) {
    env.note("budget", `Stopping before round ${env.iteration + 1}: the ${env.ap.budget.maxCredits}-credit limit is used (${spent}).`);
    return { kind: "done", summary: "Credit limit used." };
  }
  const Schema = z.object({ continueLoop: z.boolean(), focus: z.string().max(600).describe("What the next iteration should test differently"), rationale: z.string().min(1).max(1500) });
  const { args, runId } = await decide(env, {
    name: "next_iteration",
    title: `Plan round ${env.iteration + 1}`,
    instructions: always
      ? ALWAYS_ON_NEXT_INSTRUCTIONS
      : "Decide whether another iteration is worthwhile and what it should test differently, based only on measured results, the recommendations and remembered lessons. With no measured data, prefer stopping unless a clearly different test is justified. Call plan_next_iteration.",
    input: [
      `Goal: ${env.ap.goal}`,
      `Hypothesis tested: ${env.ap.hypothesis?.statement ?? ""}`,
      result ? `Analysis (${result.confidence}): ${result.summary}\nMeasured: ${result.measured.map((m) => m.text).join(" | ") || "none"}\nLimitations: ${result.limitations.join(" | ")}` : "No analysis available.",
      `Recommendations: ${recs.map((r) => `${r.title} (${r.confidence})`).join(" | ") || "none"}`,
      always ? "Always on: the next round is paced by the founder's weekly credit allowance." : `Budget left: ${env.ap.budget.maxCredits - spent} credits`,
    ].join("\n\n"),
    tool: { name: "plan_next_iteration", description: "Record whether to run another iteration and its focus.", schema: Schema },
  });
  if (always) {
    env.note("decision", `Next round (Always on): ${args.focus || "same approach, with whatever has been measured by then"}. Why: ${args.rationale}`, [ref("agentRuns", runId)], runId);
    return (await alwaysOnNextRound(env)) ?? { kind: "done", summary: "Always on was turned off." };
  }
  env.note("decision", `${args.continueLoop ? `Next round: ${args.focus}` : "Stopping here"}. Why: ${args.rationale}`, [ref("agentRuns", runId)], runId);
  if (!args.continueLoop) return { kind: "done", summary: "Muse Wonder decided not to start another round." };
  env.set({
    iteration: env.iteration + 1,
    audience: undefined,
    hypothesis: undefined,
    researchRunId: undefined,
    campaignId: undefined,
    variantIds: [],
    compositionIds: [],
    reviewIds: [],
    scheduledPostIds: [],
    recommendationIds: [],
  });
  return { kind: "advance", to: "research" };
};

export const STAGES: Record<Exclude<Stage, "done">, StageFn> = {
  understand,
  research,
  select_audience: selectAudience,
  hypothesis,
  plan_creative: planCreative,
  produce,
  verify,
  render,
  schedule,
  measure,
  learn,
};
