import type { CompositionDoc } from "@muselaunch/contracts";
import { applyPatch, themeFromBrand, validateDoc } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { createTestPlatform } from "@muselaunch/platform";
import { GlimmerClient, installGlimmerClient } from "@muselaunch/providers";
import { describe, expect, it } from "vitest";
import { rememberPreference } from "../memory";
import { installFakeGlimmer, seedApp } from "../testing";
import { brandReviewHandler, fingerprintTag, GUARDIAN_SYSTEM, loadBrandContext, mergeFindings, requestBrandReview, runRules } from "./index";
import { loadSubject } from "./subject";

/**
 * Brand Guardian unit/integration tests. Muse Glimmer is a fake llama.cpp-style SSE server serving
 * documented-shape FIXTURE answers (never live output); everything else is the real job runner.
 */

const WS = "ws_guardian";

function makeDoc(theme: CompositionDoc["theme"], shotId: string, verifiedClaimId: string, hook: { text: string; color?: string }, extra: unknown[] = []): CompositionDoc {
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
      {
        id: "sc_hook",
        name: "Hook",
        template: "hook-title",
        purpose: "hook",
        durationSec: 3,
        layers: [{ id: "ly_hook", type: "text", role: "headline", text: hook.text, box: { x: 0.08, y: 0.38, w: 0.84, h: 0.2 }, style: { sizePx: 80, color: hook.color ?? "theme.text" } }, ...extra],
      },
      {
        id: "sc_demo",
        name: "Demo",
        template: "device-demo",
        purpose: "demo",
        durationSec: 4,
        layers: [
          { id: "ly_demo_head", type: "text", role: "headline", text: "Block distracting apps during focus sessions", box: { x: 0.08, y: 0.1, w: 0.84, h: 0.14 }, style: { sizePx: 60 }, claimIds: [verifiedClaimId] },
          { id: "ly_demo_device", type: "device", screenAssetId: shotId, box: { x: 0.22, y: 0.28, w: 0.56, h: 0.56 } },
        ],
      },
      {
        id: "sc_cta",
        name: "CTA",
        template: "cta-endcard",
        purpose: "cta",
        durationSec: 3,
        layers: [{ id: "ly_cta", type: "text", role: "cta", text: "Start your first focus session", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 }, style: { sizePx: 56 } }],
      },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

async function setup(overrides: Record<string, string> = {}) {
  const p = createTestPlatform(overrides, { "brand.review": brandReviewHandler });
  await p.credits.ensureAccount(WS, { grant: 100, reason: "test" });
  const seeded = await seedApp(p, WS);
  const ws = p.db.ws(WS);
  const brand = await ws.collection("brandProfiles").getOrThrow(seeded.appId);
  const theme = themeFromBrand(brand);
  const create = async (hook: { text: string; color?: string }, extra: unknown[] = []) =>
    (await createComposition(ws, { appId: seeded.appId, title: "Focus launch", doc: makeDoc(theme, seeded.screenshotIds[0]!, seeded.claimIds.verified[0]!, hook, extra) }, "alice")).composition;
  return { p, ws, seeded, create };
}

describe("Brand Guardian rules", () => {
  it("flags prohibited claims, unverified figures, off-brand colours and unreadable text with validated fixes", async () => {
    const { ws, create } = await setup();
    const comp = await create({ text: "Works offline. 10x faster focus.", color: "#FF2D55" }, [
      { id: "ly_ghost", type: "text", role: "subhead", text: "Stay calm", box: { x: 0.1, y: 0.62, w: 0.8, h: 0.08 }, style: { sizePx: 72, color: "#EEEEEE" } },
    ]);
    const s = await loadSubject(ws, { entity: "compositions", id: comp.id });
    const { brand } = await loadBrandContext(ws, s);
    const f = runRules(s, brand);
    const byRule = (rule: string) => f.filter((x) => x.rule === rule);

    expect(byRule("prohibited.claim")[0]).toMatchObject({ severity: "block", category: "prohibited", quote: "works offline", location: { sceneId: "sc_hook", layerId: "ly_hook" }, source: "rules" });
    expect(byRule("claim.unverified_figure")[0]).toMatchObject({ severity: "block", category: "claim", quote: "10x" });
    // The verified claim on the demo headline is not flagged.
    expect(f.some((x) => x.location?.layerId === "ly_demo_head")).toBe(false);

    const palette = byRule("palette.off_brand")[0]!;
    expect(palette).toMatchObject({ severity: "warn", category: "palette", quote: "#FF2D55", location: { layerId: "ly_hook" } });
    expect(palette.suggestedOps).toEqual([{ op: "update_layer", sceneId: "sc_hook", layerId: "ly_hook", set: { style: { color: "#5C46DC" } } }]);

    const contrast = byRule("accessibility.contrast")[0]!;
    expect(contrast).toMatchObject({ severity: "block", category: "accessibility", location: { layerId: "ly_ghost" } });
    expect(contrast.message).toMatch(/1\.\d+:1/);
    // Suggested fixes apply cleanly and actually fix the problem.
    const fixed = applyPatch(s.composition!.doc, [...palette.suggestedOps!, ...contrast.suggestedOps!]).doc;
    const s2 = { ...s, composition: { ...s.composition!, doc: fixed } };
    const after = runRules(s2, brand);
    expect(after.filter((x) => x.rule === "palette.off_brand" || x.rule === "accessibility.contrast")).toEqual([]);
    // CTA matches the preferred CTA; nothing to report there.
    expect(f.some((x) => x.category === "cta")).toBe(false);
  });

  it("checks platform fit and generated media where product truth is required", async () => {
    const { ws, seeded, create } = await setup();
    const gen = await ws.collection("mediaAssets").create(
      { appId: seeded.appId, kind: "image", role: "generated_image", origin: "generated", storagePath: `workspaces/${WS}/gen.png`, mimeType: "image/png", status: "ready", isProductTruth: false, generation: { provider: "openai", model: "gpt-image-1", prompt: "phone" } },
      { actor: "seed" },
    );
    const comp = await create({ text: "Calm focus, every day" });
    const campaign = await ws.collection("campaigns").create({ appId: seeded.appId, name: "Launch", goal: "launch", channels: ["tiktok"] }, { actor: "alice" });
    await ws.collection("compositions").update(comp.id, { campaignId: campaign.id }, { actor: "alice" });
    const v = (await ws.collection("compositionVersions").getOrThrow(`${comp.id}_v1`)).doc;
    const doc = applyPatch({ ...v, aspectRatio: "16:9", width: 1920, height: 1080 }, [{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_device", set: { screenAssetId: gen.id } }]).doc;
    const s = await loadSubject(ws, { entity: "compositions", id: comp.id });
    const subject = { ...s, composition: { ...s.composition!, doc }, assets: new Map([[gen.id, gen]]) };
    const f = runRules(subject, (await loadBrandContext(ws, s)).brand);
    expect(f.find((x) => x.rule === "platform.aspect")).toMatchObject({ severity: "warn", category: "platform_fit", quote: "16:9" });
    expect(f.find((x) => x.rule === "product_truth.media")).toMatchObject({ severity: "block", location: { layerId: "ly_demo_device" } });
  });

  it("suppresses issues the team allowed before (remembered dismissals)", () => {
    const base = { severity: "warn" as const, category: "tone" as const, message: "Hype word", quote: "Blazing fast", source: "glimmer" as const, evidence: { preferenceIds: [], claimIds: [] }, location: { layerId: "ly_hook" } };
    const fp = "tone|blazing fast";
    const allowed = new Map([[fingerprintTag(fp), "prf_allowed"]]);
    const merged = mergeFindings([], [{ ...base, fingerprint: fp }, { ...base, quote: "teleports", fingerprint: "tone|teleports" }], allowed);
    expect(merged.findings.map((x) => x.quote)).toEqual(["teleports"]);
    expect(merged.suppressedBy).toEqual(["prf_allowed"]);
    expect(merged.findings[0]!.key).toBe(fingerprintTag("tone|teleports"));
  });
});

describe("Brand Guardian with Muse Glimmer (fake local server, fixture answers)", () => {
  it("parses Glimmer findings, validates ids/quotes/ops (invalid ones dropped) and records engine, latency and memory", async () => {
    const { p, ws, seeded, create } = await setup();
    const pref = await rememberPreference(p, { workspaceId: WS, appId: seeded.appId, kind: "tone", text: "Keep the voice calm; no hype words", source: { type: "explicit" }, actor: "alice" });
    const comp = await create({ text: "Blazing fast focus sessions", color: "#FF2D55" });
    const generated = await ws.collection("mediaAssets").create(
      { appId: seeded.appId, kind: "image", role: "generated_image", origin: "generated", storagePath: `workspaces/${WS}/gen.png`, mimeType: "image/png", status: "ready", isProductTruth: false, generation: { provider: "openai", model: "gpt-image-1", prompt: "app ui" } },
      { actor: "seed" },
    );
    const swap = (assetId: string, message: string) => ({ severity: "info", category: "consistency", message, ops: [{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_device", set: { screenAssetId: assetId } }] });
    const fake = installFakeGlimmer(p, (messages) => {
      const sys = messages[0]!.content;
      if (sys.includes("brand-memory curator")) return JSON.stringify({ selectedIds: [pref.id], summary: "- Keep the voice calm" });
      return (
        "```json\n" +
        JSON.stringify({
          summary: "The hook drifts from the calm voice.",
          findings: [
            { severity: "block", category: "tone", message: "\"Blazing fast\" is hype that contradicts the calm voice.", quote: "Blazing fast", location: { layerId: "ly_hook" }, replacementText: "Calm, focused sessions", preferenceIds: [pref.id, "prf_invented"], claimIds: ["clm_invented"] },
            { severity: "warn", category: "claim", message: "Claims tasks teleport.", quote: "teleports your tasks" },
            { severity: "warn", category: "consistency", message: "CTA should be lowercase", location: { layerId: "ly_cta" }, ops: [{ op: "update_layer", sceneId: "sc_cta", layerId: "ly_missing", set: { text: "x" } }] },
            { severity: "info", category: "consistency", message: "Remove the hook scene", ops: [{ op: "remove_scene", sceneId: "sc_hook" }] },
            { severity: "nope", category: "tone" },
            // Model-chosen media ids: only this app's real screenshots/recordings survive.
            swap(seeded.screenshotIds[1]!, "Show the weekly report screen"),
            swap(generated.id, "Show a generated mockup"),
            swap("ast_from_another_workspace", "Show another app"),
          ],
        }) +
        "\n```"
      );
    });
    const { review, job, reused } = await requestBrandReview(p, WS, { subject: { entity: "compositions", id: comp.id }, actor: "alice" });
    expect(reused).toBe(false);
    expect(review.status).toBe("queued");
    await p.inline!.drain();
    const done = await ws.collection("brandReviews").getOrThrow(review.id);
    expect(done).toMatchObject({ status: "warnings", subjectVersion: 1, jobId: job!.id, reviewer: { engine: "glimmer", model: "muse-glimmer", label: p.cfg.GLIMMER_LABEL } });
    expect(done.latencyMs).toBeGreaterThanOrEqual(0);
    expect(done.memoryRefs).toContain(pref.id);
    expect(done.claimIds).toEqual(expect.arrayContaining(seeded.claimIds.verified));

    const tone = done.findings.find((f) => f.source === "glimmer" && f.category === "tone")!;
    // "block" on tone is downgraded; invented ids are removed; the replacement became a validated op.
    expect(tone).toMatchObject({ severity: "warn", quote: "Blazing fast", location: { sceneId: "sc_hook", layerId: "ly_hook" }, evidence: { preferenceIds: [pref.id], claimIds: [] } });
    expect(tone.suggestedOps).toEqual([{ op: "update_layer", sceneId: "sc_hook", layerId: "ly_hook", set: { text: "Calm, focused sessions" } }]);
    // Hallucinated quote and malformed findings dropped; invalid / disallowed ops dropped.
    expect(done.findings.some((f) => f.quote === "teleports your tasks")).toBe(false);
    const cta = done.findings.find((f) => f.message === "CTA should be lowercase")!;
    expect(cta.suggestedOps).toBeUndefined();
    expect(done.findings.find((f) => f.message === "Remove the hook scene")!.suggestedOps).toBeUndefined();
    expect(done.findings.find((f) => f.message === "Show the weekly report screen")!.suggestedOps).toEqual([{ op: "update_layer", sceneId: "sc_demo", layerId: "ly_demo_device", set: { screenAssetId: seeded.screenshotIds[1] } }]);
    expect(done.findings.find((f) => f.message === "Show a generated mockup")!.suggestedOps).toBeUndefined();
    expect(done.findings.find((f) => f.message === "Show another app")!.suggestedOps).toBeUndefined();
    expect(done.summary).toMatch(/6 Glimmer suggestion\(s\) failed validation and were dropped/);
    // Rules ran too and say so.
    expect(done.findings.find((f) => f.rule === "palette.off_brand")!.source).toBe("rules");

    // The packet sent to Glimmer: brand voice, verified claims, memory and the content as untrusted data.
    const reviewReq = fake.requests.find((r) => String(r.messages[0].content).includes("Brand Guardian"))!;
    const packet = String(reviewReq.messages[1].content);
    expect(packet).toContain("Brand voice: calm, encouraging");
    expect(packet).toContain(`${seeded.claimIds.verified[0]}: Block distracting apps during focus sessions`);
    expect(packet).toContain(`${pref.id} [tone] Keep the voice calm`);
    expect(packet).toMatch(/<untrusted_content source="compositions:/);
    expect(reviewReq.chat_template_kwargs).toEqual({ reasoning_strength: "low" });
    const usage = (await ws.collection("modelUsage").list({ limit: 50 })).items.filter((u) => u.provider === "glimmer");
    expect(usage.some((u) => u.task === "brand.review" && u.jobId === job!.id && u.dataMode === "self_hosted")).toBe(true);

    // Idempotent per subject + version: asking again reuses the review; re-running the job is a no-op.
    const again = await requestBrandReview(p, WS, { subject: { entity: "compositions", id: comp.id }, version: 1, actor: "alice" });
    expect(again).toMatchObject({ reused: true, review: { id: review.id } });
    const rerun = await requestBrandReview(p, WS, { subject: { entity: "compositions", id: comp.id }, rerun: true, actor: "alice" });
    expect(rerun.review.id).not.toBe(review.id);
  });

  it("falls back to a clearly labelled rules-only review when Glimmer is not configured or unreachable", async () => {
    const off = await setup();
    const c1 = await off.create({ text: "Works offline" });
    const r1 = await requestBrandReview(off.p, WS, { subject: { entity: "compositions", id: c1.id }, actor: "alice" });
    await off.p.inline!.drain();
    const d1 = await off.ws.collection("brandReviews").getOrThrow(r1.review.id);
    expect(d1.status).toBe("blocked");
    expect(d1.reviewer.engine).toBe("rules");
    expect(d1.reviewer.note).toMatch(/isn't connected/);
    expect(d1.summary).toMatch(/^Rules-only review/);
    expect(d1.findings.every((f) => f.source === "rules")).toBe(true);

    const down = await setup({ GLIMMER_BASE_URL: "http://gpu-box.invalid:8080" });
    installGlimmerClient(down.p, new GlimmerClient(down.p, { fetch: (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch }));
    const c2 = await down.create({ text: "Calm focus, every day" });
    const r2 = await requestBrandReview(down.p, WS, { subject: { entity: "compositions", id: c2.id }, actor: "alice" });
    await down.p.inline!.drain();
    const d2 = await down.ws.collection("brandReviews").getOrThrow(r2.review.id);
    expect(d2.reviewer).toMatchObject({ engine: "rules" });
    expect(d2.reviewer.note).toMatch(/unreachable/);
    expect(d2.status).toBe("passed");
    const job = await down.p.jobs.get(WS, r2.job!.id);
    expect(job?.status).toBe("succeeded");
  });
});

describe("Brand Guardian on stills (posts, carousels, thumbnails, store screenshots)", () => {
  /** A still built from the same kit: one scene per slide (`n` slides), no motion or sound. */
  function stillDoc(theme: CompositionDoc["theme"], shotId: string, o: { kind: "static" | "carousel"; aspectRatio: CompositionDoc["aspectRatio"]; n: number; template?: string; words?: string }): CompositionDoc {
    const dims: Record<string, [number, number]> = { "4:5": [1080, 1350], "1:1": [1080, 1080], "16:9": [1920, 1080], "9:16": [1080, 1920], "9:19.5": [1290, 2796] };
    const [width, height] = dims[o.aspectRatio]!;
    const v = validateDoc({
      schemaVersion: 1,
      title: "Calm focus",
      kind: o.kind,
      aspectRatio: o.aspectRatio,
      width,
      height,
      fps: 30,
      theme,
      scenes: Array.from({ length: o.n }, (_, i) => ({
        id: `sc_s${i + 1}`,
        name: `Slide ${i + 1}`,
        template: o.template ?? (i === 0 ? "slide-cover" : i === o.n - 1 && o.kind === "carousel" ? "slide-cta" : "slide-feature"),
        purpose: i === 0 ? "hook" : "feature",
        // A still's scene length is only a render slot: lots of words in 1 s is fine.
        durationSec: 1,
        layers: [
          { id: `ly_s${i + 1}_head`, type: "text", role: "headline", text: o.words ?? `Slide ${i + 1}: one calm session at a time, every single day`, box: { x: 0.08, y: 0.08, w: 0.84, h: 0.14 }, style: { sizePx: 72 } },
          { id: `ly_s${i + 1}_device`, type: "device", screenAssetId: shotId, box: { x: 0.22, y: 0.3, w: 0.56, h: 0.6 } },
        ],
      })),
    });
    if (!v.ok) throw new Error(v.errors.join("\n"));
    return v.doc;
  }

  async function still(o: Parameters<typeof stillDoc>[2], deliverable: Record<string, unknown>, channels: string[] = ["instagram"]) {
    const { ws, seeded } = await setup();
    const brandOf = async (x: Awaited<ReturnType<typeof loadSubject>>) => (await loadBrandContext(ws, x)).brand;
    const theme = themeFromBrand(await ws.collection("brandProfiles").getOrThrow(seeded.appId));
    const campaign = await ws.collection("campaigns").create({ appId: seeded.appId, name: "Stills", goal: "awareness", channels: channels as never, deliverables: [{ aspectRatio: o.aspectRatio, count: 1, ...deliverable } as never] }, { actor: "alice" });
    const { composition } = await createComposition(ws, { appId: seeded.appId, campaignId: campaign.id, title: "Calm focus", doc: stillDoc(theme, seeded.screenshotIds[0]!, o) }, "alice");
    const s = await loadSubject(ws, { entity: "compositions", id: composition.id });
    return { s, f: runRules(s, await brandOf(s)), brand: await brandOf(s) };
  }

  it("no duration, pacing or sound findings on stills; a carousel over 10 slides for Instagram is a warning", async () => {
    const { s, f, brand } = await still({ kind: "carousel", aspectRatio: "4:5", n: 12 }, { kind: "carousel", channel: "instagram", slides: 10 });
    expect(s.channels).toEqual(["instagram"]);
    expect(f.filter((x) => /duration|reading_time|platform\.aspect$/.test(x.rule ?? ""))).toEqual([]);
    expect(f.find((x) => x.rule === "platform.slide_count")).toMatchObject({ severity: "warn", category: "platform_fit", message: expect.stringMatching(/12 slides is more than Instagram takes in one post \(10\)/) });
    expect(f.some((x) => x.rule === "platform.still_aspect")).toBe(false);
    // Glimmer is told it is reviewing slides.
    const { buildPacket } = await import("./glimmer");
    const packet = buildPacket(s, brand, [], []);
    expect(packet).toMatch(/You are reviewing slides: a carousel of 12 still slides/);
    expect(packet).toMatch(/Carousel "Calm focus" version 1 \(12 still slides, 4:5; each scene below is one slide/);
  });

  it("the aspect check uses the post's channel (a 16:9 post isn't native on Instagram; a 16:9 thumbnail is on YouTube)", async () => {
    const wide = await still({ kind: "static", aspectRatio: "16:9", n: 1 }, { kind: "static_ad", channel: "instagram" }, ["instagram", "tiktok"]);
    expect(wide.s.channels).toEqual(["instagram"]);
    expect(wide.f.find((x) => x.rule === "platform.still_aspect")).toMatchObject({ severity: "warn", quote: "16:9" });
    const thumb = await still({ kind: "static", aspectRatio: "16:9", n: 1, template: "thumbnail-bold", words: "Focus in one tap" }, { kind: "thumbnail", channel: "youtube" }, ["youtube"]);
    expect(thumb.f.filter((x) => x.category === "platform_fit")).toEqual([]);
    expect(GUARDIAN_SYSTEM).toMatch(/reviewed slide by slide: each scene is one slide/);
  });

  it("store screenshot sets are checked against their store (Google Play takes 8)", async () => {
    const { s, f } = await still({ kind: "carousel", aspectRatio: "9:16", n: 9, template: "store-screenshot", words: "Silence distracting apps" }, { kind: "store_screenshots", store: "android", slides: 8 }, ["instagram"]);
    expect(s.channels).toEqual(["google_play"]);
    expect(f.find((x) => x.rule === "platform.slide_count")).toMatchObject({ message: expect.stringMatching(/9 slides is more than Google Play takes in one post \(8\)/) });
    expect(f.some((x) => x.rule === "cta.missing_slide")).toBe(false); // store sets end on a screen, not a CTA slide
  });
});
