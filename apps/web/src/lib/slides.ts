"use client";
/**
 * Downloading the slides of a finished post, carousel, thumbnail or store set.
 *
 *  - One ZIP when the piece belongs to a campaign: the existing export package (POST
 *    /campaigns/:id/export with this one composition) puts every slide under images/ next to the
 *    captions Muse wrote and the attribution list. It runs as a job; we wait for it here.
 *  - Otherwise (or when the package can't be made), each slide is downloaded on its own through its
 *    signed asset URL, one after the other.
 */
import type { Job } from "@muselaunch/contracts";
import { TERMINAL_JOB_STATUSES } from "@muselaunch/contracts";
import { api, wsPath } from "./api";
import type { JobResponse, SignedUrl } from "./api-types";

const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

function save(url: string, name: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Each slide on its own (browsers drop rapid back-to-back downloads, so a short pause between). */
export async function downloadEachSlide(workspaceId: string, assetIds: string[]): Promise<void> {
  for (const [i, id] of assetIds.entries()) {
    const { url } = await api.get<SignedUrl>(wsPath(workspaceId, `/assets/${id}/url`), { query: { download: 1 } });
    save(url, `slide-${i + 1}`);
    if (i < assetIds.length - 1) await pause(350);
  }
}

/** The export package of one composition (a ZIP of its final slides + copy); null when it can't be made. */
async function packageZip(workspaceId: string, campaignId: string, compositionId: string, signal?: AbortSignal): Promise<string | null> {
  const r = await api.post<{ job: Job }>(wsPath(workspaceId, `/campaigns/${campaignId}/export`), { compositionIds: [compositionId], includeCopy: true }, { idempotent: true });
  let job = r.job;
  for (let i = 0; i < 90 && !(TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status); i++) {
    if (signal?.aborted) return null;
    await pause(1000);
    job = (await api.get<JobResponse>(wsPath(workspaceId, `/jobs/${job.id}`))).job;
  }
  const assetId = job.status === "succeeded" ? job.output?.data?.assetId : undefined;
  return typeof assetId === "string" ? assetId : null;
}

/**
 * "Download all": one ZIP for a set of several slides in a campaign, else each slide. Returns how it
 * was delivered so the caller can say so.
 */
export async function downloadSlides(workspaceId: string, opts: { assetIds: string[]; campaignId?: string; compositionId?: string; signal?: AbortSignal }): Promise<"zip" | "each"> {
  if (opts.assetIds.length > 1 && opts.campaignId && opts.compositionId) {
    try {
      const zip = await packageZip(workspaceId, opts.campaignId, opts.compositionId, opts.signal);
      if (zip) {
        const { url } = await api.get<SignedUrl>(wsPath(workspaceId, `/assets/${zip}/url`), { query: { download: 1 } });
        save(url, "slides.zip");
        return "zip";
      }
    } catch {
      /* fall back to each slide */
    }
  }
  await downloadEachSlide(workspaceId, opts.assetIds);
  return "each";
}
