import { brandReviewHandler } from "@muselaunch/agents";
import { seedApp, type SeededApp } from "@muselaunch/agents/testing";
import type { CompositionDoc } from "@muselaunch/contracts";
import { NeedsYouResponse } from "@muselaunch/contracts";
import { themeFromBrand, validateDoc } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * "Needs you" beyond approvals (GET /needs-you): App DNA waiting for review ("About your app") and a
 * video whose current version the Brand Guardian blocks. Neither has a one-tap route: the item links
 * to the page where the decision is made, and that page keeps its own permission checks.
 */

// biome-ignore lint: loose JSON in tests
type J = any;

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const res = async (r: Response | Promise<Response>) => {
    const x = await r;
    return { status: x.status, body: (await x.json()) as J };
  };
  return {
    get: (path: string) => res(app.request(path, { headers: auth })),
    post: (path: string, body?: unknown) => res(app.request(path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })),
  };
}

function doc(theme: CompositionDoc["theme"], shotId: string, hook: string): CompositionDoc {
  const v = validateDoc({
    schemaVersion: 1,
    title: hook,
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme,
    scenes: [
      { id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 3, layers: [{ id: "ly_hook", type: "text", role: "headline", text: hook, box: { x: 0.08, y: 0.38, w: 0.84, h: 0.2 }, style: { sizePx: 80 } }] },
      { id: "sc_demo", name: "Demo", template: "device-demo", purpose: "demo", durationSec: 4, layers: [{ id: "ly_demo_device", type: "device", screenAssetId: shotId, box: { x: 0.22, y: 0.28, w: 0.56, h: 0.56 } }] },
      { id: "sc_cta", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 3, layers: [{ id: "ly_cta", type: "text", role: "cta", text: "Start your first focus session", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 }, style: { sizePx: 56 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

describe("Needs you: About your app and the Brand check (needs-you.ts)", () => {
  const p = createTestPlatform({}, { "brand.review": brandReviewHandler, "render.final": async () => ({ creditsUsed: 0 }) });
  const app = buildApp(p);
  const alice = client(app, "alice"); // owner
  const eddie = client(app, "eddie"); // editor
  const vic = client(app, "vic"); // viewer
  const bob = client(app, "bob"); // another workspace
  let wsA = "";
  let wsB = "";
  let seeded: SeededApp;
  const W = () => `/v1/workspaces/${wsA}`;
  const ws = () => p.db.ws(wsA);
  const list = async (c: ReturnType<typeof client>, q = "") => {
    const r = await c.get(`${W()}/needs-you${q}`);
    expect(r.status).toBe(200);
    return NeedsYouResponse.parse(r.body);
  };
  const blockedComp = async (hook: string) => {
    const theme = themeFromBrand(await ws().collection("brandProfiles").getOrThrow(seeded.appId));
    const { composition } = await createComposition(ws(), { appId: seeded.appId, title: hook, doc: doc(theme, seeded.screenshotIds[0]!, hook) }, "alice");
    const review = await alice.post(`${W()}/reviews`, { subject: { entity: "compositions", id: composition.id } });
    expect(review.status).toBe(202);
    await p.inline!.drain();
    expect((await alice.get(`${W()}/reviews/${review.body.review.id}`)).body.review.status).toBe("blocked");
    return { comp: composition, reviewId: review.body.review.id as string };
  };

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).body.workspace.id;
    seeded = await seedApp(p, wsA);
    for (const [uid, role] of [
      ["eddie", "editor"],
      ["vic", "viewer"],
    ] as const)
      await ws().collection("members").create({ id: uid, userId: uid, email: `${uid}@example.com`, role, canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
  });

  it("nothing waiting → an empty list", async () => {
    expect(await list(alice)).toEqual({ items: [], count: 0 });
  });

  it("App DNA waiting for review → one item that links to About your app; confirming it clears the item", async () => {
    await ws().collection("apps").update(seeded.appId, { dnaStatus: "needs_review" }, { actor: "seed" });
    const { items, count } = await list(alice);
    expect(count).toBe(1);
    expect(items[0]).toMatchObject({
      id: seeded.appId,
      kind: "app_dna",
      appId: seeded.appId,
      subject: { entity: "apps", id: seeded.appId },
      requiredCap: "apps.write",
      canDecide: true,
      approve: null,
      reject: null,
      reviewPath: `/a/${seeded.appId}/brand`,
      preview: { factsToCheck: 1 },
    });
    expect(items[0]!.title).toBe("Check what we learned about Tidy Timer");
    expect(items[0]!.summary).toMatch(/1 fact to check\.$/);
    // The app filter has it too; editors can confirm, viewers only see it.
    expect((await list(alice, `?appId=${seeded.appId}`)).items.map((i) => i.kind)).toEqual(["app_dna"]);
    expect((await list(eddie)).items[0]!.canDecide).toBe(true);
    expect((await list(vic)).items[0]!.canDecide).toBe(false);
    // The decision goes through the existing route, with its own permission check.
    expect((await vic.post(`${W()}/apps/${seeded.appId}/dna/confirm`)).status).toBe(403);
    expect((await alice.post(`${W()}/apps/${seeded.appId}/dna/confirm`)).status).toBe(200);
    expect((await list(alice)).count).toBe(0);
  });

  it("skips App DNA while an automatic Autopilot run is accepting it on its own", async () => {
    await ws().collection("apps").update(seeded.appId, { dnaStatus: "needs_review" }, { actor: "seed" });
    const ap = await ws().collection("autopilots").create({ appId: seeded.appId, goal: "Get more installs", status: "waiting_on_jobs", stage: "understand", budget: { maxCredits: 100 }, auto: { goal: true, acceptDna: true } } as never, { actor: "alice" });
    expect((await list(alice)).items.filter((i) => i.kind === "app_dna")).toEqual([]);
    // A stopped run won't accept it, so it's the founder's decision again.
    await ws().collection("autopilots").update(ap.id, { status: "cancelled" }, { actor: "alice" });
    expect((await list(alice)).items.map((i) => i.kind)).toEqual(["app_dna"]);
    await ws().collection("apps").update(seeded.appId, { dnaStatus: "confirmed" }, { actor: "seed" });
  });

  it("a video blocked by the Brand check → one item that opens it in the Studio; a new version clears it", async () => {
    const { comp, reviewId } = await blockedComp("Works offline, anywhere");
    const { items } = await list(alice);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: reviewId,
      kind: "brand_check",
      appId: seeded.appId,
      subject: { entity: "compositions", id: comp.id },
      requiredCap: "content.write",
      canDecide: true,
      approve: null,
      reject: null,
      reviewPath: `/a/${seeded.appId}/creator/studio/${comp.id}`,
      preview: { compositionId: comp.id, compositionTitle: "Works offline, anywhere" },
    });
    expect(items[0]!.title).toBe("“Works offline, anywhere” didn’t pass the Brand check");
    expect(items[0]!.summary).toMatch(/prohibited claim/);
    expect(items[0]!.preview!.blockingIssues).toBeGreaterThanOrEqual(1);
    expect((await list(eddie)).items[0]!.canDecide).toBe(true);
    expect((await list(vic)).items[0]!.canDecide).toBe(false);

    // Fixing it in the editor makes a new version: the blocked review is of an older one.
    const edit = await alice.post(`${W()}/compositions/${comp.id}/patch`, { baseVersion: 1, ops: [{ op: "update_layer", sceneId: "sc_hook", layerId: "ly_hook", set: { text: "Calm focus, every day" } }] });
    expect(edit.status).toBe(200);
    expect((await list(alice)).count).toBe(0);
  });

  it("a blocked video someone overrode with a reason, or one Autopilot is fixing, isn't listed", async () => {
    const overridden = await blockedComp("Works offline on every flight");
    expect((await list(alice)).items.map((i) => i.subject.id)).toEqual([overridden.comp.id]);
    const ok = await alice.post(`${W()}/compositions/${overridden.comp.id}/render`, { quality: "final", override: { reason: "Offline mode ships in v2.1" } });
    expect(ok.status).toBe(202);
    await p.inline!.drain();
    expect((await list(alice)).count).toBe(0);

    const fixing = await blockedComp("Works offline, always");
    const ap = await ws().collection("autopilots").create({ appId: seeded.appId, goal: "Grow", status: "running", stage: "verify", budget: { maxCredits: 100 }, compositionIds: [fixing.comp.id] } as never, { actor: "alice" });
    expect((await list(alice)).count).toBe(0);
    // Once the loop stops (e.g. it gave up after its fix rounds), the video is the founder's decision.
    await ws().collection("autopilots").update(ap.id, { status: "failed" }, { actor: "alice" });
    expect((await list(alice)).items.map((i) => [i.kind, i.subject.id])).toEqual([["brand_check", fixing.comp.id]]);
  });

  it("is tenant-isolated", async () => {
    await ws().collection("apps").update(seeded.appId, { dnaStatus: "needs_review" }, { actor: "seed" });
    expect((await list(alice)).count).toBe(2);
    expect((await bob.get(`${W()}/needs-you`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/needs-you`)).body).toEqual({ items: [], count: 0 });
    expect((await bob.get(`/v1/workspaces/${wsB}/needs-you?appId=${seeded.appId}`)).status).toBe(404);
  });
});
