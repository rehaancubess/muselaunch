import { applyFinding, dismissFinding, isSubjectEntity, listReviews, loadSubject, requestBrandReview } from "@muselaunch/agents";
import { BrandReviewSubjectEntity, can, CreateBrandReviewRequest, DismissBrandFindingRequest } from "@muselaunch/contracts";
import { glimmerClient } from "@muselaunch/providers";
import { Hono } from "hono";
import { z } from "zod";
import { actorOf, body, idempotencyKey, query, requireCap, type AppEnv, type Ctx } from "../context";

/**
 * Owner: module G (Brand Guardian). Muse Glimmer (local) + deterministic rules review generated
 * assets before final render and approval requests. Mounted under /v1/workspaces/:workspaceId
 * (workspace scope + membership already enforced); every read/write goes through `db.ws(wid)`.
 */
export const guardianRoutes = new Hono<AppEnv>();

const wid = (c: Ctx) => c.get("workspaceId");
const p = (c: Ctx) => c.get("platform");
const ws = (c: Ctx) => p(c).db.ws(wid(c));

/** What the UI shows in the engine badge (never claims Glimmer when it isn't connected). */
function engineInfo(c: Ctx) {
  const g = glimmerClient(p(c));
  return { glimmer: { configured: g.configured, model: g.model, label: g.label } };
}

guardianRoutes.post("/reviews", requireCap("content.write"), async (c) => {
  const input = await body(c, CreateBrandReviewRequest);
  const out = await requestBrandReview(p(c), wid(c), {
    subject: input.subject,
    version: input.version,
    rerun: input.rerun,
    actor: actorOf(c),
    idempotencyKey: idempotencyKey(c),
  });
  return c.json({ ...out, ...engineInfo(c) }, out.reused ? 200 : 202);
});

const ListQuery = z.object({
  subjectId: z.string().min(1).max(128).optional(),
  /** With subjectId: lets the response flag which reviews match the subject's CURRENT content. */
  entity: BrandReviewSubjectEntity.optional(),
  appId: z.string().min(1).max(128).optional(),
  version: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(512).optional(),
});

guardianRoutes.get("/reviews", async (c) => {
  const q = query(c, ListQuery);
  const page = await listReviews(ws(c), q);
  // `current`: which reviews are of the subject's current version/content (posts and drafts have
  // no version number, so the client can't tell on its own).
  let current: { version?: number; contentHash: string } | null = null;
  const entity = q.entity ?? page.items[0]?.subject.entity;
  if (q.subjectId && entity && isSubjectEntity(entity)) {
    const s = await loadSubject(ws(c), { entity, id: q.subjectId }).catch(() => null);
    if (s) current = { version: s.version, contentHash: s.contentHash };
  }
  const items = page.items.map((r) => ({ ...r, current: current ? (current.version !== undefined ? r.subjectVersion === current.version : r.contentHash === current.contentHash) : false }));
  return c.json({ items, nextCursor: page.nextCursor, current, ...engineInfo(c) });
});

guardianRoutes.get("/reviews/:id", async (c) => {
  const review = await ws(c).collection("brandReviews").getOrThrow(c.req.param("id"));
  const job = review.jobId ? await p(c).jobs.get(wid(c), review.jobId) : null;
  return c.json({ review, job, ...engineInfo(c) });
});

guardianRoutes.post("/reviews/:id/findings/:findingId/apply", requireCap("content.write"), async (c) => {
  const out = await applyFinding(p(c), wid(c), { reviewId: c.req.param("id"), findingId: c.req.param("findingId"), actor: actorOf(c) });
  return c.json(out);
});

guardianRoutes.post("/reviews/:id/findings/:findingId/dismiss", requireCap("content.write"), async (c) => {
  const input = await body(c, DismissBrandFindingRequest);
  const out = await dismissFinding(p(c), wid(c), {
    reviewId: c.req.param("id"),
    findingId: c.req.param("findingId"),
    reason: input.reason,
    actor: actorOf(c),
    canDismissBlock: can(c.get("member"), "content.approve"),
  });
  return c.json(out);
});
