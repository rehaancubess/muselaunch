import { brandReviewHandler } from "@muselaunch/agents";
import { installFakeGlimmer, seedApp, type SeededApp } from "@muselaunch/agents/testing";
import type { CompositionDoc } from "@muselaunch/contracts";
import { themeFromBrand, validateDoc } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * Module G (Brand Guardian) through the API + real job runner. Muse Glimmer is a fake local
 * llama.cpp-style server answering with documented-shape FIXTURE JSON (never live output).
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

function doc(theme: CompositionDoc["theme"], shotId: string, claimId: string, hook: { text: string; color?: string }): CompositionDoc {
  const v = validateDoc({
    schemaVersion: 1,
    title: "Focus launch",
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme,
    scenes: [
      { id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 3, layers: [{ id: "ly_hook", type: "text", role: "headline", text: hook.text, box: { x: 0.08, y: 0.38, w: 0.84, h: 0.2 }, style: { sizePx: 80, color: hook.color ?? "theme.text" } }] },
      {
        id: "sc_demo",
        name: "Demo",
        template: "device-demo",
        purpose: "demo",
        durationSec: 4,
        layers: [
          { id: "ly_demo_head", type: "text", role: "headline", text: "Block distracting apps during focus sessions", box: { x: 0.08, y: 0.1, w: 0.84, h: 0.14 }, style: { sizePx: 60 }, claimIds: [claimId] },
          { id: "ly_demo_device", type: "device", screenAssetId: shotId, box: { x: 0.22, y: 0.28, w: 0.56, h: 0.56 } },
        ],
      },
      { id: "sc_cta", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 3, layers: [{ id: "ly_cta", type: "text", role: "cta", text: "Start your first focus session", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 }, style: { sizePx: 56 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

describe("Brand Guardian API (module G)", () => {
  const rendered: string[] = [];
  const p = createTestPlatform({}, {
    "brand.review": brandReviewHandler,
    "render.final": async (ctx) => {
      rendered.push(ctx.payload.compositionId);
      return { creditsUsed: 0 };
    },
  });
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const carol = client(app, "carol"); // editor
  const vic = client(app, "vic"); // viewer
  let wsA = "";
  let wsB = "";
  let seeded: SeededApp;
  const glimmer = { packets: [] as string[] };
  const W = () => `/v1/workspaces/${wsA}`;
  const compFor = async (hook: { text: string; color?: string }) => {
    const ws = p.db.ws(wsA);
    const theme = themeFromBrand(await ws.collection("brandProfiles").getOrThrow(seeded.appId));
    return (await createComposition(ws, { appId: seeded.appId, title: hook.text, doc: doc(theme, seeded.screenshotIds[0]!, seeded.claimIds.verified[0]!, hook) }, "alice")).composition;
  };

  beforeAll(async () => {
    installFakeGlimmer(p, (messages) => {
      const sys = messages[0]!.content;
      const user = messages[messages.length - 1]!.content;
      if (sys.includes("brand-memory curator")) return JSON.stringify({ selectedIds: [...new Set(user.match(/prf_[a-f0-9]{24}/g) ?? [])], summary: "- (fixture) apply the remembered preferences" });
      glimmer.packets.push(user);
      if (!user.includes("Blazing fast")) return JSON.stringify({ summary: "On brand: calm, specific and backed by verified claims.", findings: [] });
      const allowed = /Allowed: "Blazing fast"/.test(user);
      return JSON.stringify({
        summary: allowed ? "Hook energy was allowed by the team earlier." : "The hook is hype that drifts from the calm voice.",
        // A real model may still mention it; the deterministic memory filter must still suppress it.
        findings: [{ severity: "warn", category: "tone", message: "\"Blazing fast\" is hype that contradicts the calm, encouraging voice.", quote: "Blazing fast", location: { layerId: "ly_hook" }, replacementText: "Calm, focused sessions" }],
      });
    });
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).body.workspace.id;
    seeded = await seedApp(p, wsA);
    for (const [uid, role] of [["carol", "editor"], ["vic", "viewer"]] as const)
      await p.db.ws(wsA).collection("members").create({ id: uid, userId: uid, email: `${uid}@example.com`, role, canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
  });

  let toneReviewId = "";
  let toneCompId = "";

  it("reviews a composition version with Muse Glimmer: 202 → job → validated findings; repeat requests reuse it", async () => {
    const comp = await compFor({ text: "Blazing fast focus sessions" });
    toneCompId = comp.id;
    const created = await alice.post(`${W()}/reviews`, { subject: { entity: "compositions", id: comp.id } });
    expect(created.status).toBe(202);
    expect(created.body).toMatchObject({ review: { status: "queued", subjectVersion: 1 }, job: { type: "brand.review", payload: { appId: seeded.appId } }, glimmer: { configured: true } });
    toneReviewId = created.body.review.id;
    await p.inline!.drain();
    const got = await alice.get(`${W()}/reviews/${toneReviewId}`);
    expect(got.status).toBe(200);
    expect(got.body.review).toMatchObject({ status: "warnings", reviewer: { engine: "glimmer", model: "muse-glimmer" } });
    expect(got.body.job.status).toBe("succeeded");
    const tone = got.body.review.findings.find((f: J) => f.category === "tone");
    expect(tone).toMatchObject({ source: "glimmer", quote: "Blazing fast", suggestedOps: [{ op: "update_layer", layerId: "ly_hook", set: { text: "Calm, focused sessions" } }] });

    const again = await alice.post(`${W()}/reviews`, { subject: { entity: "compositions", id: comp.id }, version: 1 });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ reused: true, review: { id: toneReviewId } });
    const list = await alice.get(`${W()}/reviews?subjectId=${comp.id}&entity=compositions`);
    expect(list.body.items.map((r: J) => r.id)).toEqual([toneReviewId]);
    expect(list.body.items[0].current).toBe(true);
    expect(list.body.current).toMatchObject({ version: 1 });
    // Failure paths: unsupported subject (422) and unknown composition (404).
    expect((await alice.post(`${W()}/reviews`, { subject: { entity: "apps", id: seeded.appId } })).status).toBe(422);
    expect((await alice.post(`${W()}/reviews`, { subject: { entity: "compositions", id: "cmp_missing" } })).status).toBe(404);
  });

  it("dismissing a finding records a preference and the next review adapts to it", async () => {
    const r = await alice.post(`${W()}/reviews/${toneReviewId}/findings/${(await alice.get(`${W()}/reviews/${toneReviewId}`)).body.review.findings.find((f: J) => f.category === "tone").id}/dismiss`, { reason: "Our users love the energy" });
    expect(r.status).toBe(200);
    expect(r.body.review.status).toBe("passed");
    expect(r.body.preference).toMatchObject({ appId: seeded.appId, kind: "tone", text: 'Allowed: "Blazing fast" is acceptable tone — Our users love the energy', active: true, source: { type: "approval", ref: { entity: "brandReviews", id: toneReviewId } } });
    expect(r.body.preference.tags).toEqual(expect.arrayContaining(["guardian", "guardian-allow"]));
    const prefId = r.body.preference.id;

    const rerun = await alice.post(`${W()}/reviews`, { subject: { entity: "compositions", id: toneCompId }, rerun: true });
    expect(rerun.status).toBe(202);
    await p.inline!.drain();
    const next = (await alice.get(`${W()}/reviews/${rerun.body.review.id}`)).body.review;
    expect(next.status).toBe("passed");
    expect(next.findings).toEqual([]);
    expect(next.memoryRefs).toContain(prefId);
    expect(next.summary).toMatch(/Skipped 1 issue your team allowed before/);
    // Glimmer reasoned over the remembered decision (it was in the workspace-scoped packet).
    expect(glimmer.packets[glimmer.packets.length - 1]).toContain('Allowed: "Blazing fast" is acceptable tone');
  });

  it("applying a fix commits a new composition version (user_edit) and the re-review passes", async () => {
    const comp = await compFor({ text: "Calm focus, every day", color: "#FF2D55" });
    const created = await alice.post(`${W()}/reviews`, { subject: { entity: "compositions", id: comp.id } });
    await p.inline!.drain();
    const review = (await alice.get(`${W()}/reviews/${created.body.review.id}`)).body.review;
    expect(review.status).toBe("warnings");
    const palette = review.findings.find((f: J) => f.rule === "palette.off_brand");
    expect(palette).toMatchObject({ source: "rules", quote: "#FF2D55", suggestedOps: [{ op: "update_layer", set: { style: { color: "#5C46DC" } } }] });

    const applied = await alice.post(`${W()}/reviews/${review.id}/findings/${palette.id}/apply`);
    expect(applied.status).toBe(200);
    expect(applied.body.version).toMatchObject({ version: 2, parentVersion: 1, source: "user_edit" });
    expect(applied.body.patch).toMatchObject({ status: "applied", source: "user", resultVersion: 2 });
    expect(applied.body.review.findings.find((f: J) => f.id === palette.id).resolution).toMatchObject({ state: "applied", by: "alice", resultVersion: 2 });
    expect(applied.body.reReview.review).toMatchObject({ subjectVersion: 2, status: "queued" });
    await p.inline!.drain();
    const re = (await alice.get(`${W()}/reviews/${applied.body.reReview.review.id}`)).body.review;
    expect(re).toMatchObject({ status: "passed", subjectVersion: 2, reviewer: { engine: "glimmer" } });
    const compNow = (await alice.get(`${W()}/compositions/${comp.id}`)).body;
    expect(compNow.composition.currentVersion).toBe(2);
    expect(compNow.version.doc.scenes[0].layers[0].style.color).toBe("#5C46DC");
    const prefs = (await p.db.ws(wsA).collection("brandPreferences").list({ limit: 50 })).items;
    expect(prefs.some((x) => x.text.startsWith("Accepted Brand Guardian fix (brand colour use)") && x.source.type === "user_edit")).toBe(true);
  });

  it("refuses to apply a fix from a stale review (409) — the composition moved on", async () => {
    const comp = await compFor({ text: "Calm focus, every day", color: "#FF2D55" });
    const created = await alice.post(`${W()}/reviews`, { subject: { entity: "compositions", id: comp.id } });
    await p.inline!.drain();
    const review = (await alice.get(`${W()}/reviews/${created.body.review.id}`)).body.review;
    const palette = review.findings.find((f: J) => f.rule === "palette.off_brand");
    const edit = await alice.post(`${W()}/compositions/${comp.id}/patch`, { baseVersion: 1, ops: [{ op: "update_layer", sceneId: "sc_cta", layerId: "ly_cta", set: { text: "Start your first focus session today" } }] });
    expect(edit.status).toBe(200);
    const stale = await alice.post(`${W()}/reviews/${review.id}/findings/${palette.id}/apply`);
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toMatchObject({ reason: "brand_review_stale", reviewedVersion: 1, currentVersion: 2 });
    expect((await alice.get(`${W()}/compositions/${comp.id}`)).body.composition.currentVersion).toBe(2);
    // Viewers can't apply or dismiss at all.
    expect((await vic.post(`${W()}/reviews/${review.id}/findings/${palette.id}/apply`)).status).toBe(403);
    expect((await vic.post(`${W()}/reviews/${review.id}/findings/${palette.id}/dismiss`, { reason: "x" })).status).toBe(403);
  });

  it("a blocked review gates the final render until someone with the render capability overrides it with a reason (audited)", async () => {
    const comp = await compFor({ text: "Works offline, anywhere" });
    // Preview renders are never gated.
    const preview = await alice.post(`${W()}/compositions/${comp.id}/render`, { quality: "preview" });
    expect(preview.status).toBe(202);
    expect(preview.body.brandReview).toBeUndefined();

    // No review yet: the gate reviews this exact version inline, finds the prohibited claim and blocks.
    const blocked = await alice.post(`${W()}/compositions/${comp.id}/render`, { quality: "final" });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toMatchObject({ code: "APPROVAL_REQUIRED", details: { reason: "brand_review_blocked", requiresOverride: true, review: { status: "blocked", subjectVersion: 1 } } });
    expect(blocked.body.error.details.review.blocking[0]).toMatchObject({ category: "prohibited" });
    const reviewId = blocked.body.error.details.review.id;

    // Viewers can't render at all; an empty reason is rejected.
    expect((await vic.post(`${W()}/compositions/${comp.id}/render`, { quality: "final", override: { reason: "ship it" } })).status).toBe(403);
    expect((await carol.post(`${W()}/compositions/${comp.id}/render`, { quality: "final", override: { reason: " " } })).status).toBe(422);

    // The override needs the gated action's own capability (content.write), so an editor may proceed.
    const ok = await carol.post(`${W()}/compositions/${comp.id}/render`, { quality: "final", override: { reason: "Legal confirmed offline mode ships in v2.1" } });
    expect(ok.status).toBe(202);
    expect(ok.body.brandReview).toMatchObject({ id: reviewId, status: "blocked", overridden: true });
    await p.inline!.drain();
    expect(rendered).toContain(comp.id);
    const review = (await alice.get(`${W()}/reviews/${reviewId}`)).body.review;
    expect(review.overrides).toEqual([expect.objectContaining({ by: "carol", action: "render_final", reason: "Legal confirmed offline mode ships in v2.1" })]);
    const audit = (await p.db.ws(wsA).collection("auditLog").list({ limit: 100 })).items.filter((a) => a.action === "brand_review.override");
    expect(audit[0]).toMatchObject({ createdBy: "carol", target: { entity: "brandReviews", id: reviewId }, data: { gate: "render_final", version: 1, reason: "Legal confirmed offline mode ships in v2.1" } });
  });

  it("approval requests for posts are gated on the review of the exact caption", async () => {
    const ws = p.db.ws(wsA);
    const campaign = await ws.collection("campaigns").create({ appId: seeded.appId, name: "Launch", goal: "launch", channels: ["instagram"] }, { actor: "alice" });
    const post = await ws.collection("scheduledPosts").create(
      { appId: seeded.appId, campaignId: campaign.id, assetIds: [seeded.screenshotIds[0]!], channel: "instagram", mode: "manual", caption: "Tidy Timer works offline on every flight.", status: "draft" },
      { actor: "alice" },
    );
    const blocked = await alice.post(`${W()}/posts/${post.id}/request-approval`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.error.details).toMatchObject({ reason: "brand_review_blocked", review: { status: "blocked" } });
    expect((await p.db.ws(wsA).collection("approvals").list({ limit: 50 })).items.filter((a) => a.subject.id === post.id)).toEqual([]);

    // Fix the caption: the new content gets its own review, which passes.
    await ws.collection("scheduledPosts").update(post.id, { caption: "Block distracting apps during focus sessions. Start your first focus session." }, { actor: "alice" });
    const ok = await alice.post(`${W()}/posts/${post.id}/request-approval`);
    expect(ok.status).toBe(200);
    expect(ok.body.approval).toMatchObject({ action: "publish", status: "pending" });
    expect(ok.body.brandReview).toMatchObject({ status: "passed", overridden: false });
    // Only the review of the current caption is flagged `current` (posts have no version number).
    const reviews = (await alice.get(`${W()}/reviews?subjectId=${post.id}&entity=scheduledPosts`)).body.items;
    expect(reviews.map((r: J) => [r.status, r.current])).toEqual([["passed", true], ["blocked", false]]);
  });

  it("keeps reviews tenant-scoped (other workspaces get 404)", async () => {
    expect((await bob.get(`${W()}/reviews/${toneReviewId}`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/reviews/${toneReviewId}`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/reviews`, { subject: { entity: "compositions", id: toneCompId } })).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/reviews/${toneReviewId}/findings/bf_x/dismiss`, { reason: "x" })).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/reviews?subjectId=${toneCompId}`)).body.items).toEqual([]);
  });
});
