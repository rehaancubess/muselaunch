import type { JobContext, Platform } from "@muselaunch/platform";
import { createTestPlatform } from "@muselaunch/platform";
import { docHash } from "@muselaunch/compositions";
import { commitVersion, getVersion } from "@muselaunch/compositions/store";
import { renderAssetId } from "@muselaunch/render";
import { describe, expect, it } from "vitest";
import { handlers } from "../index";
import { installFakeMeta, jsonRoute, requestText, seedApp, seedRenderedVideo, type MetaRequest } from "../testing";
import { AUTOFIX_MAX_ROUNDS, autofixPatchId, autofixRoundCredits, autofixRunId, autofixStepFor, installVideoAutofixHooks } from "./autofix";

/**
 * Spark's automatic preview check through the real job runner and hooks: real video.review (frames
 * from a real MP4) and composition.edit (auto-applied patch) against fake Meta Responses answering with
 * documented-shape FIXTURE JSON (never live output). render.preview is a stub that stores the seeded
 * MP4 as the preview of each version (module C's HyperFrames renderer isn't under test here).
 */

type Review = { score: number; findings?: { sceneId: string; severity: string; check: string; issue: string; fixInstruction: string; frameRef?: string }[] };
const warnHook = (score: number): Review => ({ score, findings: [{ sceneId: "sc_hook", severity: "warn", check: "legibility", issue: "The hook text is small against the busy background (f2).", fixInstruction: "Make the hook text smaller and bolder on a plain band.", frameRef: "f2" }] });
const clean = (score: number): Review => ({ score, findings: [] });

async function setup(script: Review[], opts: { credits?: number; onReview?: (call: number) => Promise<void> | void } = {}) {
  let p!: Platform;
  const previews: number[] = [];
  p = createTestPlatform({ META_API_KEY: "test-key" }, {
    ...handlers,
    // Module C's renderer stand-in: the seeded MP4 becomes the preview of the requested version.
    "render.preview": async (ctx: JobContext<"render.preview">) => {
      const { compositionId, version } = ctx.payload;
      previews.push(version);
      const { doc } = await getVersion(ctx.ws, compositionId, version);
      const id = renderAssetId(docHash(doc), "preview", "mp4");
      const existing = await ctx.ws.collection("mediaAssets").get(id);
      if (!existing) {
        const seed = await ctx.ws.collection("mediaAssets").getOrThrow(seedAsset);
        await ctx.ws.collection("mediaAssets").create(
          { ...seed, id, labels: [`doc:${docHash(doc).slice(0, 40)}`, "9:16"], render: { compositionId, version, quality: "preview" }, title: `test preview v${version}` },
          { actor: ctx.actor },
        );
      }
      return { refs: [{ entity: "mediaAssets", id }], data: { assetId: id } };
    },
  });
  installVideoAutofixHooks(p);
  const wid = "ws_autofix";
  await p.credits.ensureAccount(wid, { grant: opts.credits ?? 500, reason: "test" });
  const seed = await seedApp(p, wid);
  const reviews: MetaRequest[] = [];
  const meta = installFakeMeta(p, [
    jsonRoute("VideoReview", (req) => {
      reviews.push(req);
      const r = script[Math.min(reviews.length - 1, script.length - 1)]!;
      void opts.onReview?.(reviews.length);
      return { score: r.score, summary: `Fixture review ${reviews.length}.`, rubric: [{ check: "legibility", verdict: r.findings?.length ? "issue" : "ok" }], findings: r.findings ?? [] };
    }),
    // Spark's scene-scoped fix: restyle the hook (no new wording, so no claim check is needed).
    jsonRoute("CompositionEdit", () => ({ summary: "Bolder hook on a plain band", targetSceneIds: ["sc_hook"], ops: [{ op: "update_layer", sceneId: "sc_hook", layerId: "ly_hook", set: { style: { sizePx: 64 + reviews.length, weight: 800 } } }] })),
    jsonRoute("ClaimValidation", () => ({ results: [] })),
  ]);
  // A storyboard-built video (calm test footage, short hook: nothing for the measurements to flag).
  const v = await seedRenderedVideo(p, wid, { appId: seed.appId, screenshotId: seed.screenshotIds[0]!, quality: "preview", hook: "Focus, finally", segments: [{ kind: "pattern", durationSec: 2 }, { kind: "pattern2", durationSec: 3 }, { kind: "pattern", durationSec: 2 }] });
  const seedAsset = v.renderAssetId;
  const ws = p.db.ws(wid);
  await ws.collection("compositions").update(v.compositionId, { storyboardId: "sbd_test_autofix" }, { actor: "seed" });
  /** The build's preview of v1 finishing (what composition.build chains). */
  const preview = async () => {
    await p.jobs.create(wid, "render.preview", { appId: seed.appId, compositionId: v.compositionId, version: 1 }, { actor: "u1", appId: seed.appId, idempotencyKey: `render.preview:${v.compositionId}:v1` });
    await p.inline!.drain();
  };
  const jobsOf = async (type: string) => (await ws.collection("jobs").list({ limit: 300 })).items.filter((j) => j.type === type);
  const last = async () => (await jobsOf("video.autofix")).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
  return { p, wid, ws, seed, v, meta, reviews, previews, preview, jobsOf, last };
}

describe("Spark's automatic preview check (video.autofix)", () => {
  it("watches the first preview, auto-applies a scene fix, re-renders, watches again and stops when clean", async () => {
    const s = await setup([warnHook(5.5), clean(8.5)]);
    const before = (await s.p.credits.balance(s.wid)).available;
    await s.preview();
    const comp = await s.ws.collection("compositions").getOrThrow(s.v.compositionId);
    expect(comp.currentVersion).toBe(2);
    const patch = await s.ws.collection("compositionPatches").getOrThrow(autofixPatchId(comp.id, 1));
    expect(patch).toMatchObject({ status: "applied", resultVersion: 2, baseVersion: 1, affectedSceneIds: ["sc_hook"], source: "ai" });
    expect(patch.instruction).toContain("Spark watched the rendered video (version 1)");
    const v2 = await getVersion(s.ws, comp.id, 2);
    expect(v2).toMatchObject({ source: "ai_edit", patchId: patch.id });
    // Both previews were watched by Spark, as automatic reviews.
    const reviews = (await s.ws.collection("videoReviews").list({ where: [["compositionId", "==", comp.id]], limit: 10 })).items.sort((a, b) => a.version - b.version);
    expect(reviews.map((r) => [r.version, r.status, r.requestedFrom, r.score])).toEqual([
      [1, "succeeded", "autofix", 5.5],
      [2, "succeeded", "autofix", 8.5],
    ]);
    expect(reviews[0]!.findings.find((f) => f.sceneId === "sc_hook")?.resolution).toMatchObject({ state: "fix_requested", patchId: patch.id });
    expect(s.previews).toEqual([1, 2]);
    const edit = (await s.jobsOf("composition.edit"))[0]!;
    expect(edit.payload).toMatchObject({ autoApply: true, baseVersion: 1, sceneIds: ["sc_hook"], patchId: patch.id });
    // The last step says why it stopped; the run holds every decision.
    const lastStep = await s.last();
    expect(lastStep?.status).toBe("succeeded");
    expect(lastStep?.output?.data).toMatchObject({ stopped: true, reason: "clean" });
    const run = await s.ws.collection("agentRuns").getOrThrow(autofixRunId(comp.id));
    expect(run.status).toBe("succeeded");
    const steps = (await s.ws.collection("agentSteps").list({ where: [["runId", "==", run.id]], orderBy: { field: "index", dir: "asc" }, limit: 50 })).items.map((x) => x.title);
    expect(steps.some((t) => /is watching the preview of “Focus launch” before you see it/.test(t))).toBe(true);
    expect(steps.some((t) => /is fixing 1 scene \(round 1 of 2\)/.test(t))).toBe(true);
    expect(steps.some((t) => /Fix round 1 applied as v2/.test(t))).toBe(true);
    expect(steps.at(-1)).toMatch(/Review clean: no fixes needed/);
    // Credits: two reviews + one edit (the stubbed preview reserves nothing, like the build's preview).
    expect((await s.p.credits.balance(s.wid)).available).toBe(before - 2 * autofixRoundCredits(s.p, 7).review - autofixRoundCredits(s.p, 7).edit);
    // Idempotent: the same preview finishing again starts nothing new.
    await s.preview();
    expect(s.reviews).toHaveLength(2);
  });

  it(`stops at the cap (${AUTOFIX_MAX_ROUNDS} rounds) and leaves the rest for the person`, async () => {
    const s = await setup([warnHook(4), warnHook(5), warnHook(6)]);
    await s.preview();
    const comp = await s.ws.collection("compositions").getOrThrow(s.v.compositionId);
    expect(comp.currentVersion).toBe(1 + AUTOFIX_MAX_ROUNDS);
    expect(s.reviews).toHaveLength(AUTOFIX_MAX_ROUNDS + 1);
    expect(await s.ws.collection("compositionPatches").get(autofixPatchId(comp.id, AUTOFIX_MAX_ROUNDS + 1))).toBeNull();
    expect((await s.last())?.output?.data).toMatchObject({ reason: "cap" });
  });

  it("stops when a fix didn't raise Spark's score", async () => {
    const s = await setup([warnHook(6), warnHook(5)]);
    await s.preview();
    const comp = await s.ws.collection("compositions").getOrThrow(s.v.compositionId);
    expect(comp.currentVersion).toBe(2);
    expect(await s.ws.collection("compositionPatches").get(autofixPatchId(comp.id, 2))).toBeNull();
    expect((await s.last())?.output?.data).toMatchObject({ reason: "no_improvement", before: 6, after: 5 });
  });

  it("doesn't start without credits for a whole round (edit + preview + review), and says so", async () => {
    const s = await setup([warnHook(5)], { credits: 8 });
    await s.preview();
    expect(s.reviews).toHaveLength(0);
    expect(await s.jobsOf("video.review")).toHaveLength(0);
    const data = (await s.last())?.output?.data as Record<string, unknown>;
    expect(data).toMatchObject({ stopped: true, reason: "credits", available: 8 });
    expect(data.needed).toBe(autofixRoundCredits(s.p, 7).total);
  });

  it("never fixes a video a person edited while Spark was watching", async () => {
    let s!: Awaited<ReturnType<typeof setup>>;
    s = await setup([warnHook(5)], {
      onReview: async (call) => {
        if (call !== 1) return;
        const { doc } = await getVersion(s.ws, s.v.compositionId, 1);
        await commitVersion(s.ws, s.v.compositionId, { baseVersion: 1, doc: { ...doc, title: "My own edit" }, source: "user_edit", summary: "Renamed" }, "u1");
      },
    });
    await s.preview();
    const comp = await s.ws.collection("compositions").getOrThrow(s.v.compositionId);
    expect(comp.currentVersion).toBe(2);
    expect((await getVersion(s.ws, comp.id, 2)).source).toBe("user_edit");
    expect(await s.jobsOf("composition.edit")).toHaveLength(0);
    expect((await s.last())?.output?.data).toMatchObject({ reason: "edited" });
    // A preview of the person's version doesn't restart the check.
    await s.p.jobs.create(s.wid, "render.preview", { appId: s.seed.appId, compositionId: comp.id, version: 2 }, { actor: "u1", appId: s.seed.appId, idempotencyKey: "user-preview-v2" });
    await s.p.inline!.drain();
    expect(s.reviews).toHaveLength(1);
  });

  it("stays out when switched off, for Growth Autopilot's videos, and for copies (variants)", async () => {
    const off = await setup([warnHook(5)]);
    const now = new Date().toISOString();
    await off.p.db.top("workspaces").set(off.wid, { id: off.wid, workspaceId: off.wid, name: "Off", slug: "off", ownerId: "u1", planId: "free", spendCeilingUsd: 25, settings: { defaultTimezone: "UTC", defaultLocale: "en", metaDataMode: "standard", autopilot: { enabled: true, autoApproveRenders: true }, videoReview: { autoFix: false } }, createdAt: now, updatedAt: now, createdBy: "u1" });
    await off.preview();
    expect(await off.jobsOf("video.autofix")).toHaveLength(0);
    expect(off.reviews).toHaveLength(0);

    const ap = await setup([warnHook(5)]);
    await ap.ws.collection("autopilots").create({ appId: ap.seed.appId, goal: "Grow installs", status: "running", stage: "render", budget: { maxCredits: 200 }, compositionIds: [ap.v.compositionId] }, { actor: "u1" });
    await ap.preview();
    expect((await ap.last())?.output?.data).toMatchObject({ skipped: expect.stringMatching(/Growth Autopilot/) });
    expect(ap.reviews).toHaveLength(0);

    const copy = await setup([warnHook(5)]);
    await copy.ws.collection("compositions").update(copy.v.compositionId, { derivedFromCompositionId: "cmp_original" }, { actor: "seed" });
    await copy.preview();
    expect(await copy.jobsOf("video.autofix")).toHaveLength(0);
  });

  it("is workspace-scoped: another workspace's jobs and ids never reach this video", async () => {
    const s = await setup([clean(9)]);
    // A preview job in another workspace naming this composition id finds nothing there.
    expect(await autofixStepFor(s.p, "ws_other", { id: "job_x", type: "render.preview", appId: s.seed.appId, payload: { compositionId: s.v.compositionId, version: 1 } })).toBeNull();
    // A step queued in another workspace for this id fails (not found), and nothing here changes.
    await s.p.credits.ensureAccount("ws_other", { grant: 100, reason: "test" });
    const j = await s.p.jobs.create("ws_other", "video.autofix", { appId: s.seed.appId, compositionId: s.v.compositionId, trigger: "preview", version: 1 }, { actor: "u2", appId: s.seed.appId });
    await s.p.inline!.drain();
    const done = await s.p.jobs.get("ws_other", j.id);
    expect(done?.status).toBe("failed");
    expect(done?.error?.code).toBe("NOT_FOUND");
    expect(s.reviews).toHaveLength(0);
    expect((await s.ws.collection("videoReviews").list({ limit: 5 })).items).toHaveLength(0);
    // Spark only ever saw this workspace's frames (the review prompt names the video, not other tenants').
    await s.preview();
    expect(requestText(s.reviews[0]!)).toContain("Focus launch");
  });
});
