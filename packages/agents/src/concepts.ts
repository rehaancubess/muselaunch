import { AngleType, AUTO_VIDEO_DURATION, Channel, type CampaignVariant, type Deliverable, type DeliverableKind } from "@muselaunch/contracts";
import { createHash } from "node:crypto";
import { AppError, toAppError, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { untrusted } from "@muselaunch/providers";
import { z } from "zod";
import { dnaSummary, loadAppContext, requireDna } from "./context";
import { retrieveMemory } from "./memory";
import { engineName, plannedEngine, sparkJson } from "./models";
import { RunRecorder } from "./runs";
import { autoCampaignName, clip, hashId, jaccard, truncateWords, uniq } from "./util";

const Metric = z.object({ metric: z.string().min(1).max(80), target: z.string().max(120).optional(), measurement: z.string().max(500).optional() });

export const ConceptsOutput = z.object({
  brief: z.object({
    campaignName: z.string().min(1).max(60).optional().describe("Short campaign name, 2-6 words, no quotes or emoji (e.g. 'Calm focus for exam season')"),
    audienceDescription: z.string().min(1).max(1500),
    segmentIds: z.array(z.string()).max(5).default([]),
    angle: z.string().min(1).max(1000).describe("The campaign's overall strategic angle"),
    usp: z.string().min(1).max(1000),
    cta: z.string().min(1).max(200),
    brandStyle: z.string().max(1000).optional(),
    visualDirection: z.string().max(1500).optional(),
    successMetric: Metric,
    approvedClaimIds: z.array(z.string()).max(20).default([]),
  }),
  variants: z
    .array(
      z.object({
        title: z.string().min(1).max(160),
        angleType: AngleType,
        hook: z.string().min(1).max(400).describe("First 1-2 seconds: what is said/shown"),
        audience: z.string().min(1).max(600),
        keyMessage: z.string().min(1).max(800),
        rationale: z.string().min(1).max(2000).describe("Why this could work for THIS app, citing findings/opportunities/memory where relevant"),
        findingIds: z.array(z.string()).max(10).default([]),
        claimIds: z.array(z.string()).max(10).default([]),
        scriptOutline: z.array(z.string().max(400)).min(3).max(8),
        channels: z.array(Channel).max(6).default([]),
        hypothesis: z.string().min(1).max(600).describe("A testable hypothesis, e.g. 'A problem-first hook gets more saves than a demo-first hook among students'"),
        successMetric: Metric,
        memoryIdsUsed: z.array(z.string()).max(10).default([]),
        targetDurationSec: z.number().min(5).max(120).optional().describe("Video length in seconds for this concept, 30-60; vary it across concepts (e.g. one ~30 s punchy cut, one 45-60 s walkthrough)"),
      }),
    )
    .min(3)
    .max(6),
});
type ConceptsOutput = z.infer<typeof ConceptsOutput>;

const VIDEO_KINDS = new Set<DeliverableKind>(["short_video", "app_demo", "feature_promo", "launch_announcement", "app_trailer"]);

/** Deterministic pseudo-random length in AUTO_VIDEO_DURATION, seeded by the concept id (fallback when Spark gives none). */
export function seededDuration(id: string, min: number = AUTO_VIDEO_DURATION.min, max: number = AUTO_VIDEO_DURATION.max): number {
  const n = createHash("sha256").update(`duration:${id}`).digest().readUInt32BE(0);
  return min + (n % (max - min + 1));
}

/** The workspace plan's longest video (seconds); lengths are clamped to it. */
export async function planMaxVideoSec(p: Platform, workspaceId: string): Promise<number> {
  const ws = await p.db.top("workspaces").get(workspaceId);
  const plans = p.credits.plans as Record<string, { limits: { maxVideoSec: number } } | undefined>;
  return (plans[ws?.planId ?? "free"] ?? plans.free)?.limits.maxVideoSec ?? AUTO_VIDEO_DURATION.max;
}

/** The founder's video length for this campaign, if they chose one (else concepts pick their own). */
export function founderDuration(deliverables: Deliverable[]): number | undefined {
  return deliverables.find((d) => VIDEO_KINDS.has(d.kind) && d.durationSec)?.durationSec;
}

/**
 * One length per concept: the founder's choice when given; else Spark's pick clamped to 30–60 s, or a
 * seeded fallback. Concepts that all came out (nearly) the same length are spread out (one ≈30 s, one 45–60 s).
 */
export function conceptDurations(picks: (number | undefined)[], ids: string[], fixed?: number, planMax: number = AUTO_VIDEO_DURATION.max): number[] {
  if (fixed) return picks.map(() => Math.min(fixed, planMax));
  const max = Math.min(AUTO_VIDEO_DURATION.max, planMax);
  const min = Math.min(AUTO_VIDEO_DURATION.min, max);
  if (max - min < 10) return picks.map((v, i) => (v ? Math.max(min, Math.min(max, Math.round(v))) : seededDuration(ids[i]!, min, max)));
  let d = picks.map((v, i) => (v ? Math.max(min, Math.min(max, Math.round(v))) : seededDuration(ids[i]!)));
  if (d.length >= 2 && Math.max(...d) - Math.min(...d) < 10) d = d.map((_, i) => (i === 0 ? seededDuration(ids[i]!, min, min + 5) : i === 1 ? seededDuration(ids[i]!, Math.max(min, max - 15), max) : seededDuration(ids[i]!, min, max)));
  return d;
}

/** Strategic distinctness: different angle types and clearly different hooks/messages. */
export function distinctnessProblems(variants: ConceptsOutput["variants"], allowed: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Map<string, number>();
  variants.forEach((v, i) => {
    if (!allowed.includes(v.angleType)) problems.push(`Concept ${i + 1} uses angleType "${v.angleType}", which is not allowed here.`);
    const prev = seen.get(v.angleType);
    if (prev !== undefined) problems.push(`Concepts ${prev + 1} and ${i + 1} share angleType "${v.angleType}"; each concept needs a different strategic angle.`);
    seen.set(v.angleType, i);
  });
  for (let i = 0; i < variants.length; i++) {
    for (let j = i + 1; j < variants.length; j++) {
      const a = variants[i]!;
      const b = variants[j]!;
      const sim = jaccard(`${a.hook} ${a.keyMessage}`, `${b.hook} ${b.keyMessage}`);
      if (sim >= 0.5) problems.push(`Concepts ${i + 1} and ${j + 1} are too similar (hook/message overlap ${Math.round(sim * 100)}%).`);
    }
  }
  return problems;
}

const INSTRUCTIONS = `You are Muse Spark acting as MuseLaunch's creative strategist. Produce a campaign brief and strategically DISTINCT campaign concepts for an indie app.

Rules:
- Each concept must use a different angleType and a genuinely different hook, audience framing and message — not copy variants of one idea.
- Ground every concept in the App DNA: real features, real audiences. When research findings are provided, every concept lists in findingIds the finding ids it builds on (at least one) and its rationale says how; never cite a finding that doesn't support it. Use opportunities and team memory (accepted/rejected angles, lessons) and avoid angles the team rejected.
- brief.campaignName: a short, human campaign name (2-6 words) summarising the request.
- Product claims in hooks/messages must come from the verified claims list (reference their ids in claimIds). Never invent numbers, testimonials, reviews, awards or user counts.
- social_proof is only allowed when it appears in the allowed angle types (real proof exists).
- scriptOutline: 3-8 beats following hook → problem → demo → features → (real) proof → CTA; demo beats must show the real app (screenshots/recordings), never generated UI.
- targetDurationSec: unless the founder fixed a length, pick each concept's video length between 30 and 60 seconds to fit its story, and vary it across concepts (e.g. one ≈30 s punchy cut, one 45-60 s walkthrough).
- hypothesis + successMetric must be measurable on the chosen channels (views, saves, clicks, installs, subscriptions); do not promise outcomes.`;

export async function generateConceptsHandler(ctx: JobContext<"campaign.generate_concepts">): Promise<JobResult> {
  const p = ctx.platform;
  const { appId, campaignId, count } = ctx.payload;
  const ws = ctx.ws;
  const campaign = await ws.collection("campaigns").getOrThrow(campaignId);
  if (campaign.appId !== appId) throw new AppError("BAD_REQUEST", "Campaign does not belong to this app");
  const runId = hashId("run", ctx.job.id);
  const existing = (await ws.collection("campaignVariants").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 })).items.filter((v) => v.generatedByRunId === runId);
  if (existing.length >= count) return { refs: existing.map((v) => ({ entity: "campaignVariants", id: v.id })), data: { alreadyGenerated: true } };

  const app = await loadAppContext(ws, appId);
  const dna = requireDna(app);
  const rec = await RunRecorder.start(ctx, { id: runId, kind: "campaign_concepts", model: plannedEngine(p, "concepts.generate").model, goal: clip(`Concepts for "${campaign.name}": ${campaign.request ?? campaign.goal}`, 4000), appId });
  try {
    await ctx.progress(10, "gathering research and memory");
    const [findingsPage, oppsPage, segmentsPage, evidencePage] = await Promise.all([
      ws.collection("researchFindings").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 }),
      ws.collection("opportunities").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 30 }),
      ws.collection("audienceSegments").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 }),
      ws.collection("appEvidence").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 150 }),
    ]);
    const findings = findingsPage.items;
    const chosenOpps = oppsPage.items.filter((o) => campaign.opportunityIds.includes(o.id));
    const opps = [...chosenOpps, ...oppsPage.items.filter((o) => !campaign.opportunityIds.includes(o.id) && o.status !== "dismissed").sort((a, b) => b.score - a.score).slice(0, 5)];
    const memory = await retrieveMemory(p, { workspaceId: ctx.workspaceId, appId, task: "campaign_concepts", query: `${campaign.request ?? ""} ${campaign.goal}`, jobId: ctx.job.id, agentRunId: rec.id });
    await rec.step({ kind: "message", title: `Brand memory: ${memory.items.length} items (${memory.usedGlimmer ? "selected by Muse Glimmer" : "deterministic ranking; Glimmer not connected"})`, output: memory.summary || "(no memory yet)" });

    const hasProof = evidencePage.items.some((e) => e.kind === "metric" && e.reviewState === "verified");
    const allowed = AngleType.options.filter((a) => a !== "other" && (a !== "social_proof" || hasProof));
    // No length given = each concept picks its own (30–60 s).
    const deliverables: Deliverable[] = campaign.deliverables.length ? campaign.deliverables : [{ kind: "short_video", channel: campaign.channels[0], aspectRatio: "9:16", count: 1 }];
    const channels = campaign.channels.length ? campaign.channels : (["instagram"] as const);
    const planMax = await planMaxVideoSec(p, ctx.workspaceId);
    const fixedDuration = founderDuration(deliverables);
    const autoMax = Math.min(AUTO_VIDEO_DURATION.max, planMax);

    const input = [
      `Founder's request: ${clip(campaign.request ?? campaign.name, 4000)}`,
      `Goal: ${campaign.goal} · Channels: ${channels.join(", ")} · Deliverables: ${deliverables.map((d) => `${d.count}× ${d.kind} ${d.aspectRatio}${d.durationSec ? ` ${d.durationSec}s` : ""}`).join(", ")}`,
      fixedDuration ? `Video length: ${Math.min(fixedDuration, planMax)} s for every concept (the founder's choice).` : `Video length: pick targetDurationSec per concept between ${Math.min(AUTO_VIDEO_DURATION.min, autoMax)} and ${autoMax} s, varied across concepts.`,
      `Produce exactly ${count} concepts. Allowed angle types: ${allowed.join(", ")}.`,
      memory.items.length ? `Team memory (id: kind — text):\n${memory.items.map((m) => `- ${m.id}: ${m.kind} — ${m.text}`).join("\n")}\nSummary: ${memory.summary}` : "Team memory: (none yet)",
      "",
      untrusted("app_dna", dnaSummary(app), 14_000),
      "",
      untrusted("research_findings", findings.length ? findings.map((f) => `- ${f.id} [${f.kind}] ${f.statement}${f.interpretation ? ` → ${f.interpretation}` : ""} (sources: ${f.evidence.map((e) => e.url).filter(Boolean).slice(0, 2).join(", ")})`).join("\n") : "(no research yet)", 12_000),
      "",
      untrusted("opportunities", opps.length ? opps.map((o) => `- ${o.id}${campaign.opportunityIds.includes(o.id) ? " (CHOSEN BY FOUNDER)" : ""}: ${o.title} — ${o.proposedAngle} (score ${o.score}, findings: ${o.findingIds.join(", ") || "none"})`).join("\n") : "(none)", 6000),
      "",
      `Audience segments (id: name): ${segmentsPage.items.map((s) => `${s.id}: ${s.name}`).join("; ") || "(none)"}`,
    ].join("\n");

    await ctx.progress(30, `${plannedEngine(p, "concepts.generate").name} is developing concepts`);
    let out = await sparkJson(p, rec, "concepts.generate", { ctx: rec.callCtx("concepts.generate"), instructions: INSTRUCTIONS, input, schema: ConceptsOutput, schemaName: "CampaignConcepts", maxOutputTokens: 10_000, reasoningEffort: "medium", cacheKey: "agents.concepts" });
    await rec.modelStep(`Generate brief + concepts (${engineName(out.model)})`, out, { findings: findings.length, opportunities: opps.length, memory: memory.items.length }, out.data.variants.map((v) => `${v.angleType}: ${v.title}`).join("\n"));
    let problems = distinctnessProblems(out.data.variants.slice(0, count), allowed);
    if (out.data.variants.length < count) problems.push(`Only ${out.data.variants.length} concepts returned; ${count} required.`);
    if (problems.length) {
      ctx.throwIfCancelled();
      const used = new Set(out.data.variants.map((v) => v.angleType));
      const repair = `${input}\n\nYour previous concepts were not strategically distinct:\n${problems.map((x) => `- ${x}`).join("\n")}\nUnused allowed angle types: ${allowed.filter((a) => !used.has(a)).join(", ")}.\nPrevious concepts:\n${JSON.stringify(out.data.variants.map((v) => ({ title: v.title, angleType: v.angleType, hook: v.hook })))}\nReturn the full JSON again with ${count} distinct concepts.`;
      out = await sparkJson(p, rec, "concepts.generate", { ctx: rec.callCtx("concepts.distinctness_repair"), instructions: INSTRUCTIONS, input: repair, schema: ConceptsOutput, schemaName: "CampaignConcepts", maxOutputTokens: 10_000, reasoningEffort: "medium", cacheKey: "agents.concepts" });
      await rec.modelStep(`Repair: make concepts distinct (${engineName(out.model)})`, out, problems, out.data.variants.map((v) => `${v.angleType}: ${v.title}`).join("\n"));
      problems = distinctnessProblems(out.data.variants.slice(0, count), allowed);
      if (problems.length || out.data.variants.length < count) {
        throw new AppError("PROVIDER_ERROR", `Concepts were not strategically distinct after repair: ${problems.join(" ")}`, { retryable: true, userMessage: `${engineName(out.model)} couldn't produce clearly different concepts. Please retry or refine the request.` });
      }
    }
    ctx.throwIfCancelled();
    await ctx.progress(75, "saving concepts");

    const verifiedIds = new Set(app.verifiedClaims.map((c) => c.id));
    const findingIds = new Set(findings.map((f) => f.id));
    const memoryIds = new Set(memory.items.map((m) => m.id));
    const segmentIds = new Set(segmentsPage.items.map((s) => s.id));
    const priorBriefs = (await ws.collection("campaignBriefs").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 1 })).items;
    const b = out.data.brief;
    const chosen = out.data.variants.slice(0, count);
    const variantIds = chosen.map((_, i) => hashId("var", campaignId, runId, i));
    const durations = conceptDurations(
      chosen.map((v) => v.targetDurationSec),
      variantIds,
      fixedDuration,
      planMax,
    );
    const { entity: brief } = await ws.collection("campaignBriefs").createIfAbsent(
      {
        id: hashId("brf", campaignId, ctx.job.id),
        appId,
        campaignId,
        version: (priorBriefs[0]?.version ?? 0) + 1,
        goal: campaign.goal,
        audience: { segmentIds: b.segmentIds.filter((s) => segmentIds.has(s)), description: b.audienceDescription },
        channels: [...channels],
        angle: b.angle,
        usp: b.usp,
        approvedClaimIds: uniq([...b.approvedClaimIds, ...out.data.variants.flatMap((v) => v.claimIds)]).filter((c) => verifiedIds.has(c)),
        cta: b.cta,
        deliverables,
        targetDurationsSec: uniq(durations).sort((x, y) => x - y),
        brandStyle: b.brandStyle ?? (dna.visual.styleKeywords.join(", ") || undefined),
        visualDirection: b.visualDirection,
        budgetCapCredits: campaign.creditCap,
        successMetric: b.successMetric,
        locales: app.app.targetLanguages.length ? app.app.targetLanguages : ["en"],
        status: "draft",
      },
      { actor: ctx.actor },
    );
    const variants: CampaignVariant[] = [];
    for (const [i, v] of chosen.entries()) {
      const { entity } = await ws.collection("campaignVariants").createIfAbsent(
        {
          id: variantIds[i]!,
          targetDurationSec: durations[i],
          appId,
          campaignId,
          title: v.title,
          angleType: v.angleType,
          hook: v.hook,
          audience: v.audience,
          keyMessage: v.keyMessage,
          rationale: v.rationale,
          findingIds: v.findingIds.filter((f) => findingIds.has(f)),
          claimIds: v.claimIds.filter((c) => verifiedIds.has(c)),
          scriptOutline: v.scriptOutline,
          channels: v.channels.length ? v.channels : [...channels],
          hypothesis: v.hypothesis,
          successMetric: v.successMetric,
          status: "proposed",
          memoryRefs: v.memoryIdsUsed.filter((m) => memoryIds.has(m)),
          generatedByRunId: runId,
        },
        { actor: ctx.actor },
      );
      variants.push(entity);
    }
    for (const o of chosenOpps) if (o.status === "new" || o.status === "saved") await ws.collection("opportunities").update(o.id, { status: "used", campaignId }, { actor: ctx.actor });
    // Replace the provisional name (derived from the request) with Spark's short name; a name the user chose is kept.
    const spokenName = b.campaignName ? truncateWords(b.campaignName.replace(/["“”]/g, ""), 60) : "";
    const rename = spokenName && campaign.request && campaign.name === autoCampaignName(campaign.request) ? { name: spokenName } : {};
    await ws.collection("campaigns").update(campaignId, { status: "concepts_ready", briefId: brief.id, ...rename }, { actor: ctx.actor });
    await rec.finish("succeeded", { outputRefs: [{ entity: "campaignBriefs", id: brief.id }, ...variants.map((v) => ({ entity: "campaignVariants", id: v.id }))], memoryRefs: memory.items.map((m) => m.id) });
    await ctx.progress(100, "concepts ready");
    return { refs: [{ entity: "campaignBriefs", id: brief.id }, ...variants.map((v) => ({ entity: "campaignVariants", id: v.id })), { entity: "agentRuns", id: rec.id }], data: { usedGlimmer: memory.usedGlimmer, angleTypes: variants.map((v) => v.angleType), durationsSec: variants.map((v) => v.targetDurationSec) } };
  } catch (raw) {
    const err = toAppError(raw);
    await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}
