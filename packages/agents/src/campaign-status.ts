import { TERMINAL_JOB_STATUSES, type Campaign, type Job } from "@muselaunch/contracts";
import type { Platform } from "@muselaunch/platform";

/**
 * Campaign production lifecycle (module B): `producing` → `review` once every variant sent to
 * production has finished its chain — storyboard.generate → storyboard.resolve_media →
 * composition.build → render.preview —
 * successfully or with a failure at any step. Variants whose video was built are marked `produced`.
 * Driven by a job-status hook (installCampaignHooks) and re-checked when a campaign is read.
 */

const CHAIN = new Set<Job["type"]>(["storyboard.generate", "storyboard.resolve_media", "composition.build", "render.preview"]);
const done = (j: Pick<Job, "status">) => TERMINAL_JOB_STATUSES.includes(j.status);

export async function syncCampaignProduction(p: Platform, workspaceId: string, campaignId: string): Promise<Campaign | null> {
  const ws = p.db.ws(workspaceId);
  const campaign = await ws.collection("campaigns").get(campaignId);
  if (!campaign || campaign.status !== "producing") return campaign;
  const jobs = (await ws.collection("jobs").list({ where: [["appId", "==", campaign.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 300 })).items;
  // Newest storyboard job per variant (retries supersede earlier attempts).
  const latest = new Map<string, Job>();
  for (const j of jobs) if (j.type === "storyboard.generate" && j.payload.campaignId === campaignId && !latest.has(String(j.payload.variantId))) latest.set(String(j.payload.variantId), j);
  if (!latest.size) return campaign;
  const child = (parent: Job, type: Job["type"]) => jobs.find((j) => j.parentJobId === parent.id && j.type === type);
  const produced: string[] = [];
  for (const [variantId, sb] of latest) {
    if (!done(sb)) return campaign;
    if (sb.status !== "succeeded") continue;
    // storyboard → storyboard.resolve_media (b-roll) → composition.build; older chains skip the b-roll hop.
    const media = child(sb, "storyboard.resolve_media");
    if (media && !done(media)) return campaign;
    const build = child(sb, "composition.build") ?? (media && child(media, "composition.build"));
    if (!build) continue;
    if (!done(build)) return campaign;
    if (build.status !== "succeeded") continue;
    const preview = child(build, "render.preview");
    if (preview && !done(preview)) return campaign;
    produced.push(variantId);
  }
  const variants = await ws.collection("campaignVariants").getMany(produced);
  for (const v of variants) if (v.status === "selected" || v.status === "proposed") await ws.collection("campaignVariants").update(v.id, { status: "produced" }, { actor: "system" });
  const fresh = await ws.collection("campaigns").get(campaignId);
  if (!fresh || fresh.status !== "producing") return fresh;
  return ws.collection("campaigns").update(campaignId, { status: "review" }, { actor: "system" });
}

/** Move campaigns out of `producing` as their production jobs finish (install in every process that runs jobs). */
const installed = new WeakSet<Platform>();

export function installCampaignHooks(p: Platform): () => void {
  if (installed.has(p)) return () => {};
  installed.add(p);
  const off = p.jobs.addHooks({
    onStatus: async ({ workspaceId, job, to }) => {
      if (!CHAIN.has(job.type) || !done({ status: to }) || !job.appId) return;
      const ws = p.db.ws(workspaceId);
      let campaignId = typeof job.payload.campaignId === "string" ? job.payload.campaignId : undefined;
      if (!campaignId && typeof job.payload.compositionId === "string") campaignId = (await ws.collection("compositions").get(job.payload.compositionId))?.campaignId;
      if (!campaignId && typeof job.payload.storyboardId === "string") campaignId = (await ws.collection("storyboards").get(job.payload.storyboardId))?.campaignId;
      if (campaignId) await syncCampaignProduction(p, workspaceId, campaignId).catch((err) => p.log.warn({ err, campaignId }, "campaign status sync failed"));
    },
  });
  return () => {
    installed.delete(p);
    off();
  };
}
