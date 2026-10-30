import { renderForVersion, requestVideoFix, requestVideoReview, videoReviewsFor } from "@muselaunch/agents";
import { CreateVideoReviewRequest, FixVideoReviewRequest, type VideoReview } from "@muselaunch/contracts";
import { assertKeyInWorkspace, toAppError } from "@muselaunch/platform";
import { chooseTextModel, metaClient } from "@muselaunch/providers";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, idempotencyKey, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Owner: Track 4 (Spark video review). Muse Spark watches frames of a rendered MP4 and reviews what
 * viewers see; "Fix these scenes" turns findings into a proposed scene-scoped AI edit. Mounted under
 * /v1/workspaces/:workspaceId (membership enforced); every read/write goes through `db.ws(wid)`.
 */
export const videoReviewRoutes = new Hono<AppEnv>();

const wid = (c: Ctx) => c.get("workspaceId");
const p = (c: Ctx) => c.get("platform");
const ws = (c: Ctx) => p(c).db.ws(wid(c));
const FRAME_URL_TTL = 30 * 60;

/** Who will watch (never claims Muse Spark when nothing is connected) and what it costs. */
function engineInfo(c: Ctx) {
  const choice = chooseTextModel(p(c), "video.review");
  return {
    engine: { name: choice.name, label: choice.label, configured: choice.engine === "muse-spark-open" || metaClient(p(c)).configured },
    credits: p(c).credits.estimate("video.review").credits,
  };
}

/** Signed URLs of a review's frames (ref → url), workspace-checked. */
async function frameUrls(c: Ctx, review: VideoReview | null): Promise<Record<string, string>> {
  if (!review?.frames.length) return {};
  const assets = await ws(c).collection("mediaAssets").getMany(review.frames.flatMap((f) => (f.assetId ? [f.assetId] : [])));
  const out: Record<string, string> = {};
  for (const f of review.frames) {
    const a = assets.find((x) => x.id === f.assetId);
    if (!a || a.status !== "ready") continue;
    assertKeyInWorkspace(wid(c), a.storagePath);
    out[f.ref] = (await p(c).storage.signedDownloadUrl(a.storagePath, { expiresSec: FRAME_URL_TTL })).url;
  }
  return out;
}

videoReviewRoutes.post("/compositions/:id/video-reviews", requireCap("content.write"), async (c) => {
  const input = await body(c, CreateVideoReviewRequest);
  const out = await requestVideoReview(p(c), wid(c), {
    compositionId: c.req.param("id"),
    version: input.version,
    renderAssetId: input.renderAssetId,
    rerun: input.rerun,
    actor: actorOf(c),
    requestedFrom: "studio",
    idempotencyKey: idempotencyKey(c),
  });
  return c.json({ ...out, ...engineInfo(c) }, out.reused ? 200 : 202);
});

const ListQuery = z.object({ version: z.coerce.number().int().min(1).optional() });

/**
 * Reviews of a composition (newest first) + the newest review of `version` (default: current) with
 * its frame URLs, and the render a new review would watch (null = render this version first).
 */
videoReviewRoutes.get("/compositions/:id/video-reviews", async (c) => {
  const comp = await ws(c).collection("compositions").getOrThrow(c.req.param("id"));
  const { version: v } = query(c, ListQuery);
  const version = v ?? comp.currentVersion;
  const items = await videoReviewsFor(ws(c), comp.id, 20);
  const current = items.find((r) => r.version === version) ?? null;
  let render: { assetId: string; quality: "final" | "preview" } | null = null;
  let supported = true;
  try {
    const r = await renderForVersion(ws(c), comp, version);
    render = { assetId: r.asset.id, quality: r.quality };
  } catch (raw) {
    const err = toAppError(raw);
    if (err.code === "BAD_REQUEST") supported = false;
    else if (err.code !== "CONFLICT") throw raw;
  }
  const job = current?.jobId ? await p(c).jobs.get(wid(c), current.jobId) : null;
  return c.json({ items, current, version, frameUrls: await frameUrls(c, current), job, render, supported, ...engineInfo(c) });
});

videoReviewRoutes.get("/video-reviews/:id", async (c) => {
  const review = await ws(c).collection("videoReviews").getOrThrow(c.req.param("id"));
  const job = review.jobId ? await p(c).jobs.get(wid(c), review.jobId) : null;
  return c.json({ review, job, frameUrls: await frameUrls(c, review), ...engineInfo(c) });
});

/** "Fix these scenes": a PROPOSED scene-scoped AI edit from the findings (applied by a person, like any AI edit). */
videoReviewRoutes.post("/video-reviews/:id/fix", requireCap("content.write"), async (c) => {
  const input = await body(c, FixVideoReviewRequest);
  const out = await requestVideoFix(p(c), wid(c), { reviewId: c.req.param("id"), findingIds: input.findingIds, actor: actorOf(c), idempotencyKey: idempotencyKey(c) });
  return c.json(out, 202);
});
