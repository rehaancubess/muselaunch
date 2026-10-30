import { videoReviewHandler } from "@muselaunch/agents";
import { installFakeMeta, jsonRoute, seedApp, seedRenderedVideo, type SeededApp } from "@muselaunch/agents/testing";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * Track 4 (Spark video review) through the API + real job runner: a real MP4 made from FFmpeg test
 * sources, Muse Spark answered by the fake Meta Responses API with FIXTURE JSON (never live output).
 */

// biome-ignore lint: loose JSON in tests
type J = any;

function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const res = async (r: Response | Promise<Response>) => {
    const x = await r;
    return { status: x.status, body: (await x.json()) as J };
  };
  return {
    get: (path: string) => res(app.request(path, { headers: auth })),
    post: (path: string, body?: unknown) => res(app.request(path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })),
  };
}

describe("Spark video review API (routes/video-reviews.ts)", () => {
  const p = createTestPlatform({ META_API_KEY: "test-key" }, { "video.review": videoReviewHandler });
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const vic = client(app, "vic"); // viewer
  let wsA = "";
  let seeded: SeededApp;
  const W = () => `/v1/workspaces/${wsA}`;

  beforeAll(async () => {
    installFakeMeta(p, [
      jsonRoute("VideoReview", () => ({
        score: 6,
        summary: "Readable overall; the demo scene is black. (fixture)",
        rubric: [{ check: "cta", verdict: "ok" }],
        findings: [{ sceneId: "sc_cta", severity: "warn", check: "legibility", issue: "The CTA is small (f4).", fixInstruction: "Make the CTA larger.", frameRef: "f4" }],
      })),
    ]);
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await bob.post("/v1/workspaces", { name: "Bob Studio" });
    seeded = await seedApp(p, wsA);
    await p.db.ws(wsA).collection("members").create({ id: "vic", userId: "vic", email: "vic@example.com", role: "viewer", canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
  });

  it("Review with Spark: 202 → job → frames + findings; repeat reuses it; Fix these scenes proposes a scene-scoped edit; tenancy and roles hold", async () => {
    const v = await seedRenderedVideo(p, wsA, { appId: seeded.appId, screenshotId: seeded.screenshotIds[0]! });
    const before = await alice.get(`${W()}/compositions/${v.compositionId}/video-reviews`);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({ current: null, version: 1, render: { assetId: v.renderAssetId, quality: "final" }, supported: true, engine: { name: "Muse Spark", configured: true }, credits: 6 });

    const created = await alice.post(`${W()}/compositions/${v.compositionId}/video-reviews`, {});
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ review: { status: "queued", version: 1, requestedFrom: "studio" }, job: { type: "video.review" }, reused: false });
    await p.inline!.drain();

    const list = await alice.get(`${W()}/compositions/${v.compositionId}/video-reviews`);
    expect(list.body.current).toMatchObject({ id: created.body.review.id, status: "succeeded", verdict: "blockers", score: 6 });
    expect(list.body.job.status).toBe("succeeded");
    expect(Object.keys(list.body.frameUrls)).toEqual(["f1", "f2", "f3", "f4"]);
    const findings = list.body.current.findings as J[];
    expect(findings.map((f) => [f.check, f.sceneId, f.severity, f.source])).toEqual([
      ["hook_readability", "sc_hook", "blocker", "measured"],
      ["broken_frame", "sc_demo", "blocker", "measured"],
      ["legibility", "sc_cta", "warn", "spark"],
    ]);
    const one = await alice.get(`${W()}/video-reviews/${created.body.review.id}`);
    expect(one.status).toBe(200);
    expect(Object.keys(one.body.frameUrls)).toHaveLength(4);

    const again = await alice.post(`${W()}/compositions/${v.compositionId}/video-reviews`, {});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, review: { id: created.body.review.id } });

    // Viewers can look but not run or fix; another workspace can't see it at all.
    expect((await vic.get(`${W()}/compositions/${v.compositionId}/video-reviews`)).status).toBe(200);
    expect((await vic.post(`${W()}/compositions/${v.compositionId}/video-reviews`, {})).status).toBe(403);
    expect((await vic.post(`${W()}/video-reviews/${created.body.review.id}/fix`, {})).status).toBe(403);
    expect((await bob.get(`${W()}/video-reviews/${created.body.review.id}`)).status).toBe(404);
    expect((await alice.get(`${W()}/compositions/cmp_missing/video-reviews`)).status).toBe(404);

    // Fix these scenes (only the CTA warning) → a proposed composition.edit for that scene only.
    const ctaFinding = findings.find((f) => f.sceneId === "sc_cta");
    const fix = await alice.post(`${W()}/video-reviews/${created.body.review.id}/fix`, { findingIds: [ctaFinding.id] });
    expect(fix.status).toBe(202);
    expect(fix.body.patch).toMatchObject({ status: "proposed", affectedSceneIds: ["sc_cta"] });
    expect(fix.body.job).toMatchObject({ type: "composition.edit", payload: { sceneIds: ["sc_cta"], autoApply: false } });
    expect((await alice.post(`${W()}/video-reviews/${created.body.review.id}/fix`, { findingIds: ["vf_nope"] })).status).toBe(400);

    // A version with no render can't be reviewed yet (409, honest).
    const edited = await alice.post(`${W()}/compositions/${v.compositionId}/patch`, { baseVersion: 1, ops: [{ op: "update_layer", sceneId: "sc_cta", layerId: "ly_cta", set: { text: "Start focusing today" } }], summary: "edit" });
    expect(edited.status).toBe(200);
    const unrendered = await alice.get(`${W()}/compositions/${v.compositionId}/video-reviews`);
    expect(unrendered.body).toMatchObject({ version: 2, current: null, render: null });
    const refused = await alice.post(`${W()}/compositions/${v.compositionId}/video-reviews`, {});
    expect(refused.status).toBe(409);
    expect(refused.body.error.details.reason).toBe("no_render");
  });
});
