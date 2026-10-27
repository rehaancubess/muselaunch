import { Channel, CampaignGoal, type Campaign, type Job, type Opportunity, type ResearchRun } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, type Platform } from "@muselaunch/platform";
import { z } from "zod";

export const InvestigateRequest = z.object({ focus: z.string().max(1000).optional() });

export const CreateCampaignFromOpportunity = z.object({
  name: z.string().min(1).max(160).optional(),
  request: z.string().max(4000).optional(),
  goal: CampaignGoal.optional(),
  channels: z.array(Channel).min(1).max(8).optional(),
  conceptCount: z.number().int().min(3).max(6).default(3),
});

async function loadOpp(ws: WorkspaceDb, appId: string, id: string): Promise<Opportunity> {
  const o = await ws.collection("opportunities").getOrThrow(id);
  if (o.appId !== appId) throw new AppError("NOT_FOUND", "Opportunity not found");
  return o;
}

export async function setOpportunityStatus(ws: WorkspaceDb, appId: string, id: string, status: "new" | "saved" | "dismissed", actor: string): Promise<Opportunity> {
  const o = await loadOpp(ws, appId, id);
  if (o.status === "used" && status !== "saved") throw new AppError("CONFLICT", "This opportunity already has a campaign");
  return ws.collection("opportunities").update(o.id, { status }, { actor });
}

/** "Investigate": a focused Wonder research run (module B's `research.run`) seeded from the opportunity. */
export async function investigateOpportunity(
  p: Platform,
  wid: string,
  appId: string,
  id: string,
  input: z.infer<typeof InvestigateRequest>,
  opts: { actor: string; idempotencyKey?: string },
): Promise<{ run: ResearchRun; job: Job; opportunity: Opportunity }> {
  const ws = p.db.ws(wid);
  const o = await loadOpp(ws, appId, id);
  const app = await ws.collection("apps").getOrThrow(appId);
  const focus = [`Investigate this opportunity in depth: "${o.title}" (${o.topic}).`, `Angle: ${o.proposedAngle}`, input.focus ? `Developer's question: ${input.focus}` : ""].filter(Boolean).join("\n").slice(0, 1000);
  const kinds = o.contentType === "creator_collab" ? (["creators", "audience"] as const) : (["trends", "audience", "opportunities"] as const);
  const run = await ws.collection("researchRuns").create(
    {
      appId,
      kinds: [...kinds],
      status: "queued",
      inputs: { countries: o.geography.length ? o.geography : app.targetCountries, languages: app.targetLanguages, channels: o.channels, competitorIds: [], focus },
    },
    { actor: opts.actor },
  );
  let job: Job;
  try {
    job = await p.jobs.create(wid, "research.run", { appId, researchRunId: run.id, kinds: [...kinds] }, { actor: opts.actor, appId, idempotencyKey: opts.idempotencyKey ?? `investigate:${o.id}:${run.id}`, credits: { operation: "research.run" } });
  } catch (err) {
    await ws.collection("researchRuns").delete(run.id);
    throw err;
  }
  await ws.collection("researchRuns").update(run.id, { jobId: job.id }, { actor: opts.actor });
  const opportunity = await ws.collection("opportunities").update(o.id, { investigationRunIds: [...o.investigationRunIds, run.id].slice(-20), status: o.status === "new" ? "saved" : o.status }, { actor: opts.actor });
  return { run, job, opportunity };
}

const GOAL_BY_TYPE: Partial<Record<Opportunity["contentType"], z.infer<typeof CampaignGoal>>> = { launch: "launch", community_post: "community", creator_collab: "awareness" };

/** "Create campaign": Campaign seeded with the opportunity + module B's `campaign.generate_concepts`. */
export async function campaignFromOpportunity(
  p: Platform,
  wid: string,
  appId: string,
  id: string,
  input: z.infer<typeof CreateCampaignFromOpportunity>,
  opts: { actor: string; idempotencyKey?: string },
): Promise<{ campaign: Campaign; job: Job; opportunity: Opportunity }> {
  const ws = p.db.ws(wid);
  const o = await loadOpp(ws, appId, id);
  if (o.status === "used" && o.campaignId) {
    const existing = await ws.collection("campaigns").get(o.campaignId);
    if (existing) throw new AppError("CONFLICT", "A campaign was already created from this opportunity", { details: { campaignId: existing.id } });
  }
  const channels = input.channels ?? (o.channels.length ? o.channels.slice(0, 8) : ["instagram", "tiktok"]);
  const request =
    input.request ??
    `Create a campaign from this Discover opportunity.\nOpportunity: ${o.title}\nTopic: ${o.topic}\nAudience: ${o.audience}\nWhy it's relevant: ${o.whyRelevant}\nProposed angle: ${o.proposedAngle}\nFormat: ${o.contentType} (${o.effort} effort)`;
  const campaign = await ws.collection("campaigns").create(
    { appId, name: input.name ?? o.title.slice(0, 160), goal: input.goal ?? GOAL_BY_TYPE[o.contentType] ?? "awareness", status: "planning", request: request.slice(0, 4000), channels, opportunityIds: [o.id] },
    { actor: opts.actor },
  );
  let job: Job;
  try {
    job = await p.jobs.create(wid, "campaign.generate_concepts", { appId, campaignId: campaign.id, count: input.conceptCount }, {
      actor: opts.actor,
      appId,
      idempotencyKey: opts.idempotencyKey ?? `concepts:${campaign.id}`,
      credits: { operation: "campaign.generate_concepts" },
    });
  } catch (err) {
    await ws.collection("campaigns").delete(campaign.id);
    throw err;
  }
  const opportunity = await ws.collection("opportunities").update(o.id, { status: "used", campaignId: campaign.id }, { actor: opts.actor });
  return { campaign, job, opportunity };
}
