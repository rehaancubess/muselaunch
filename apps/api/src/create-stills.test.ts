import { seedApp, type SeededApp } from "@muselaunch/agents/testing";
import { advanceCreateRun } from "@muselaunch/autopilot";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { CreateRunsResponse, CreateRunView, NeedsYouResponse, type Deliverable, type Job } from "@muselaunch/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * Create runs for stills (a post, a carousel, a thumbnail, a store screenshot set) and text posts, on
 * the server: the request → the idea → Muse Spark's slide plan (or the post) → the editable slides →
 * the Brand check → the final slide images. Fixture model routes only (labelled); renders and reviews
 * are the harness's labelled stubs; nothing is ever posted.
 */

// biome-ignore lint: loose JSON in tests
type J = any;

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const send = (method: string) => async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as J };
  };
  return { get: send("GET"), post: send("POST") };
}

const request = (deliverable: Record<string, unknown>, channels = ["instagram"]) => ({ request: "Show students how Tidy Timer gives their focus back.", goal: "awareness", channels, deliverables: [{ count: 1, aspectRatio: "4:5", ...deliverable }], conceptCount: 3, origin: "create" });

describe("Create runs: stills and text posts on the server", () => {
  const h = autopilotPlatform();
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  let wid = "";
  let seeded: SeededApp;
  const W = () => `/v1/workspaces/${wid}`;
  const ws = () => p.db.ws(wid);
  const jobsOf = async (type: Job["type"], campaignId: string) => (await ws().collection("jobs").list({ where: [["appId", "==", seeded.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((j) => j.type === type && (j.payload.campaignId === campaignId || j.payload.compositionId));
  const runOf = async (id: string) => CreateRunView.parse((await alice.get(`${W()}/create-runs/${id}`)).body.run);

  beforeAll(async () => {
    wid = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await bob.post("/v1/workspaces", { name: "Bob Studio" });
    await p.credits.grant(wid, 2000, { reason: "test", idempotencyKey: "create-stills-test", actor: "system" });
    seeded = await seedApp(p, wid);
  });

  it("a carousel: planned as slides, rendered as JPEG slide images, the run's stills in order (no video)", async () => {
    const created = await alice.post(`${W()}/apps/${seeded.appId}/campaigns`, request({ kind: "carousel", channel: "instagram", slides: 4 }));
    expect(created.status).toBe(202);
    const id = created.body.campaign.id as string;
    await p.inline!.drain();
    const run = await runOf(id);
    expect(run).toMatchObject({ status: "done", stage: "done", pct: 100, format: { output: "carousel", aspectRatio: "4:5", slides: 4, channel: "instagram" }, video: null, text: null });
    expect(run.format.lengthSec).toBeUndefined();
    expect(run.stills?.assetIds).toHaveLength(4);
    const slides = await ws().collection("mediaAssets").getMany(run.stills!.assetIds);
    expect(slides.map((a) => a.labels.find((l) => l.startsWith("slide:")))).toEqual(["slide:1", "slide:2", "slide:3", "slide:4"]);
    for (const a of slides) expect(a).toMatchObject({ kind: "image", role: "render", status: "ready", render: { compositionId: run.compositionId, quality: "final" } });
    // Muse Spark planned slides (not a video storyboard), and the final render was JPEG at the still price.
    const [board] = await jobsOf("storyboard.generate", id);
    expect(board!.payload).toMatchObject({ format: "carousel", slides: 4, aspectRatio: "4:5" });
    expect(board!.payload.targetDurationSec).toBeUndefined();
    const story = await ws().collection("storyboards").getOrThrow((await ws().collection("campaignVariants").getOrThrow(run.variantId!)).storyboardId!);
    expect(story.format).toBe("carousel");
    expect(story.scenes.map((x) => x.template)).toEqual(["slide-cover", "slide-feature", "slide-feature", "slide-cta"]);
    const comp = await ws().collection("compositions").getOrThrow(run.compositionId!);
    expect(comp.kind).toBe("carousel");
    const final = (await jobsOf("render.final", id)).find((j) => j.payload.compositionId === comp.id)!;
    expect(final.payload).toMatchObject({ format: "jpeg" });
    expect(final.reservation?.credits).toBe(1); // ceil(4 slides / 4)
    // Never a spend decision for stills, and nothing posted.
    expect((await ws().collection("campaigns").getOrThrow(id)).createRun?.approvedSpend).toBeUndefined();
    expect((await ws().collection("scheduledPosts").list({ where: [["appId", "==", seeded.appId]], limit: 10 })).items).toHaveLength(0);
    // The list shows it too.
    const listed = CreateRunsResponse.parse((await alice.get(`${W()}/apps/${seeded.appId}/create-runs`)).body).items.find((r) => r.campaignId === id)!;
    expect(listed.stills?.assetIds).toEqual(run.stills!.assetIds);
  });

  it("App Store screenshots: the 1290×2796 frame, PNG, one screenshot per real screen", async () => {
    const created = await alice.post(`${W()}/apps/${seeded.appId}/campaigns`, request({ kind: "store_screenshots", aspectRatio: "9:19.5", store: "ios", slides: 6 }, ["app_store"]));
    expect(created.status).toBe(202);
    const id = created.body.campaign.id as string;
    await p.inline!.drain();
    const run = await runOf(id);
    expect(run).toMatchObject({ status: "done", format: { output: "store_screenshots", aspectRatio: "9:19.5", store: "ios", slides: 6 } });
    // The sample app has two real screenshots: the set has three (the App Store minimum, the second screen once more), never made-up screens.
    expect(run.stills!.assetIds).toHaveLength(3);
    const comp = await ws().collection("compositions").getOrThrow(run.compositionId!);
    const final = (await jobsOf("render.final", id)).find((j) => j.payload.compositionId === comp.id)!;
    expect(final.payload).toMatchObject({ format: "png" });
    const slide = await ws().collection("mediaAssets").getOrThrow(run.stills!.assetIds[0]!);
    expect(slide).toMatchObject({ width: 1290, height: 2796 });
  });

  it("a text post for X: the idea, then the post within 280 characters, fact-checked; no plan, no render", async () => {
    const created = await alice.post(`${W()}/apps/${seeded.appId}/campaigns`, request({ kind: "text_post", channel: "x", aspectRatio: "1:1" }, ["x"]));
    expect(created.status).toBe(202);
    const id = created.body.campaign.id as string;
    await p.inline!.drain();
    const run = await runOf(id);
    expect(run).toMatchObject({ status: "done", stage: "done", format: { output: "text_post", channel: "x" }, video: null, stills: null, text: { channel: "x", ok: true } });
    expect(run.text!.text.length).toBeLessThanOrEqual(280);
    expect(run.text!.text).toMatch(/\[APP_LINK\]/);
    const pack = await ws().collection("copyPacks").getOrThrow(run.text!.copyPackId);
    expect(pack).toMatchObject({ campaignId: id, channel: "x", variantId: run.variantId });
    const [copy] = await jobsOf("copy.generate", id);
    expect(copy).toMatchObject({ createdBy: "alice", payload: { channels: ["x"], variantId: run.variantId } });
    expect(copy!.idempotencyKey).toBe(`alice:create-copy-${id}`);
    expect(await jobsOf("storyboard.generate", id)).toHaveLength(0);
    expect((await ws().collection("compositions").list({ where: [["campaignId", "==", id]], limit: 5 })).items).toHaveLength(0);
  });

  it("produce accepts a still format (else the campaign's still deliverable), and refuses a still frame for a video", async () => {
    const created = await alice.post(`${W()}/apps/${seeded.appId}/campaigns`, { request: "Make a thumbnail and a post", channels: ["youtube"], deliverables: [{ kind: "thumbnail", aspectRatio: "16:9", count: 1 }] });
    const id = created.body.campaign.id as string;
    await p.inline!.drain();
    const variants = (await alice.get(`${W()}/campaigns/${id}`)).body.variants as J[];
    // No format given: the campaign's still deliverable (a thumbnail).
    const auto = await alice.post(`${W()}/campaigns/${id}/variants/${variants[0].id}/produce`, {}, { "idempotency-key": "prod-auto" });
    expect(auto.status).toBe(202);
    expect(auto.body.job.payload).toMatchObject({ format: "thumbnail" });
    // An explicit carousel with a slide count.
    const carousel = await alice.post(`${W()}/campaigns/${id}/variants/${variants[1].id}/produce`, { format: "carousel", slides: 5, aspectRatio: "1:1" }, { "idempotency-key": "prod-carousel" });
    expect(carousel.body.job.payload).toMatchObject({ format: "carousel", slides: 5, aspectRatio: "1:1" });
    expect(carousel.body.job.reservation.credits).toBe(3 + 3);
    // Store screenshots default to the App Store; a video can't be 9:19.5.
    const store = await alice.post(`${W()}/campaigns/${id}/variants/${variants[2].id}/produce`, { format: "store_screenshots" }, { "idempotency-key": "prod-store" });
    expect(store.body.job.payload).toMatchObject({ format: "store_screenshots", store: "ios" });
    expect((await alice.post(`${W()}/campaigns/${id}/variants/${variants[2].id}/produce`, { format: "video", aspectRatio: "9:19.5" }, { "idempotency-key": "prod-bad" })).status).toBe(400);
    // Other workspaces don't see the campaign.
    expect((await bob.post(`${W()}/campaigns/${id}/variants/${variants[0].id}/produce`, {})).status).toBe(404);
    await p.inline!.drain();
  });

  it("estimates what Create shows: a still plan on its slides, the final images per 4 slides, a text post as one copy pack", async () => {
    const est = async (operation: string, params: Record<string, unknown> = {}) => (await alice.post(`${W()}/estimate`, { operation, params })).body.credits as number;
    expect(await est("storyboard.generate", { format: "carousel", slides: 6 })).toBe(3 + 3);
    expect(await est("storyboard.generate", { format: "store_screenshots", slides: 10, store: "android" })).toBe(3 + 4); // clamped to 8
    expect(await est("storyboard.generate", { format: "post" })).toBe(3 + 1);
    expect(await est("storyboard.generate", { format: "thumbnail", slides: 5 })).toBe(3 + 1);
    expect(await est("storyboard.generate", { targetDurationSec: 30 })).toBe(8 + 3); // videos unchanged
    expect(await est("render.final", { slides: 6 })).toBe(2);
    expect(await est("render.final", { slides: 1 })).toBe(1);
    expect(await est("render.final", { durationSec: 30 })).toBe(16); // videos unchanged
    expect(await est("copy.generate")).toBe(4);
  });

  it("Needs you names the piece: “Your carousel…”, “Your screenshots are…”", async () => {
    await ws().collection("members").create({ id: "carol", userId: "carol", email: "carol@example.com", role: "viewer", canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
    // A run stopped just before its plan (the ideas are written), acting as `by`.
    const seedRun = async (deliverable: Deliverable, by: string) => {
      const campaign = await ws().collection("campaigns").create(
        { appId: seeded.appId, name: "Calm focus", goal: "awareness", request: "Slides for students.", channels: ["instagram"], deliverables: [deliverable], status: "concepts_ready", origin: "create", createRun: { startedBy: by, actingAs: by, status: "working", stage: "plan", waits: 0, jobIds: [], touchedAt: new Date(h.clock.now).toISOString() } },
        { actor: by },
      );
      await ws().collection("campaignVariants").create({ appId: seeded.appId, campaignId: campaign.id, title: "Three small changes", angleType: "practical_demo", hook: "Your phone wins. Again?", audience: "Students", keyMessage: "Calm focus", rationale: "r", hypothesis: "h", successMetric: { metric: "saves" }, status: "proposed" }, { actor: "seed" });
      return campaign.id;
    };
    const needs = async () => NeedsYouResponse.parse((await alice.get(`${W()}/needs-you?appId=${seeded.appId}`)).body).items;

    const shots = await seedRun({ kind: "store_screenshots", aspectRatio: "9:19.5", store: "ios", count: 1 }, "carol");
    await advanceCreateRun(p, wid, shots, { source: "sweep" });
    const stopped = await runOf(shots);
    expect(stopped).toMatchObject({ status: "needs_you", stage: "plan", decision: { kind: "permission" } });
    expect(stopped.decision!.message).toMatch(/can no longer make store screenshots in this workspace, so Muse stopped here\. An editor can continue them\./);
    expect((await needs()).find((i) => i.subject.id === shots)).toMatchObject({ title: "Your screenshots are waiting for an editor", labels: { approved: "Muse carries on with your screenshots. Nothing is posted without your OK.", rejected: "Left unfinished. They stay in the editor, and you can continue them from Create." } });

    const bal = await p.credits.balance(wid);
    const hold = await p.credits.reserve(wid, bal.available, { operation: "test", idempotencyKey: "stills-drain", actor: "system" });
    const carousel = await seedRun({ kind: "carousel", aspectRatio: "4:5", slides: 5, count: 1 }, "alice");
    await advanceCreateRun(p, wid, carousel, { source: "sweep" });
    expect((await runOf(carousel)).decision).toMatchObject({ kind: "credits", stepKey: expect.stringMatching(/^produce:/) });
    expect((await needs()).find((i) => i.subject.id === carousel)).toMatchObject({ title: "Not enough credits to finish your carousel", labels: { approve: "Try again" } });
    await p.credits.release(wid, hold.reservationId, { actor: "system", reason: "test" });

    const post = await seedRun({ kind: "text_post", channel: "linkedin", aspectRatio: "1:1", count: 1 }, "carol");
    await advanceCreateRun(p, wid, post, { source: "sweep" });
    expect((await runOf(post)).decision?.message).toMatch(/can no longer make posts in this workspace/);
    expect((await needs()).find((i) => i.subject.id === post)).toMatchObject({ title: "Your post is waiting for an editor", labels: { rejected: "Left unfinished. It stays with the campaign, and you can continue it from Create." } });
  });
});
