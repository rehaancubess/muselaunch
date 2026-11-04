import type { CompositionDoc, CopyPack } from "@muselaunch/contracts";
import { AI_VOICE_CAPTION_LINE } from "@muselaunch/contracts";
import { buildFromStoryboard, docHash } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { createTestPlatform, workspaceKey } from "@muselaunch/platform";
import { strFromU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { handlers } from "./handlers";
import { renderCacheKey } from "./keys";
import { usesAiVoice, withAiVoiceCopy } from "./package";
import { sampleStillStoryboard } from "./sample";
import { finalStillEncoding } from "./stills";
import { seedSample } from "./test-seed";

/**
 * Export of still compositions without Chrome: the final slide assets are seeded as a render would
 * leave them (fixture bytes, labelled as fixtures), then package.export zips them.
 */
describe("package.export of stills", () => {
  const { "render.preview": _a, "render.final": _b, ...noRender } = handlers;
  const p = createTestPlatform({}, noRender);
  const wid = "ws_pkg_stills";

  async function seedStill(format: "carousel" | "thumbnail" | "store_screenshots", store?: "ios" | "android") {
    const ws = p.db.ws(wid);
    const seed = await seedSample(p, wid);
    const sb = sampleStillStoryboard(wid, format, { store, id: `sbd_${format}_${store ?? "x"}` });
    const { id: sbId, workspaceId: _w, createdAt: _c, updatedAt: _u, createdBy: _cb, ...rest } = sb;
    await ws.collection("storyboards").createIfAbsent({ id: sbId, ...rest }, { actor: "fixture" });
    const app = await ws.collection("apps").getOrThrow(seed.appId);
    const assets = (await ws.collection("mediaAssets").list({ where: [["appId", "==", seed.appId]], limit: 50 })).items;
    const doc = buildFromStoryboard({ storyboard: sb, app, brand: null, assets });
    const id = `cmp_${format}_${store ?? "x"}`;
    await createComposition(ws, { id, appId: seed.appId, campaignId: "cpg_sample", variantId: "var_sample", storyboardId: sbId, title: sb.title, doc }, "u1");
    const enc = finalStillEncoding(doc, "png", sb);
    const key = renderCacheKey(docHash(doc), "final", enc);
    for (let i = 0; i < doc.scenes.length; i++) {
      const aid = i === 0 ? `ast_r_${key}` : `ast_r_${key}_${i + 1}`;
      const path = workspaceKey(wid, "renders", id, `slide${i + 1}.${enc === "png" ? "png" : "jpg"}`);
      await p.storage.put(path, new TextEncoder().encode(`FIXTURE slide ${i + 1} of ${id}`), { contentType: enc === "png" ? "image/png" : "image/jpeg" });
      await ws.collection("mediaAssets").createIfAbsent(
        { id: aid, appId: seed.appId, campaignId: "cpg_sample", kind: "image", role: "render", origin: "render", storagePath: path, mimeType: enc === "png" ? "image/png" : "image/jpeg", bytes: 30, width: doc.width, height: doc.height, status: "ready", labels: ["fixture", `slide:${i + 1}`], isProductTruth: false, render: { compositionId: id, version: 1, quality: "final" } },
        { actor: "fixture" },
      );
    }
    return { id, doc, slides: doc.scenes.length };
  }

  it("exports every slide in order: carousels in their folder, thumbnails, store sets in a store folder with upload notes", async () => {
    const car = await seedStill("carousel");
    const thumb = await seedStill("thumbnail");
    const ios = await seedStill("store_screenshots", "ios");
    const android = await seedStill("store_screenshots", "android");
    const job = await p.jobs.create(wid, "package.export", { appId: "app_focusly", campaignId: "cpg_sample", compositionIds: [car.id, thumb.id, ios.id, android.id], includeCopy: false }, { actor: "u1" });
    await p.inline!.drain();
    const done = await p.jobs.get(wid, job.id);
    expect(done?.status, JSON.stringify(done?.error)).toBe("succeeded");
    const asset = await p.db.ws(wid).collection("mediaAssets").getOrThrow(done!.output!.data!.assetId as string);
    const zip = unzipSync(new Uint8Array(await p.storage.get(asset.storagePath)));
    const names = Object.keys(zip).sort();
    const carousel = names.filter((n) => n.startsWith("carousels/focusly-mornings-carousel-4x5/"));
    expect(carousel).toEqual(["slide-01.jpg", "slide-02.jpg", "slide-03.jpg", "slide-04.jpg"].map((f) => `carousels/focusly-mornings-carousel-4x5/${f}`));
    expect(strFromU8(zip[carousel[2]!]!)).toBe(`FIXTURE slide 3 of ${car.id}`);
    expect(names).toContain("thumbnails/focusly-thumbnail-16x9.jpg");
    expect(names.filter((n) => n.startsWith("app-store/focusly-app-store-screenshots/"))).toEqual(["slide-01.png", "slide-02.png", "slide-03.png"].map((f) => `app-store/focusly-app-store-screenshots/${f}`));
    expect(names.filter((n) => n.startsWith("google-play/"))).toHaveLength(4);
    expect(strFromU8(zip["app-store/README.txt"]!)).toMatch(/App Store Connect.*Previews and Screenshots/s);
    expect(strFromU8(zip["google-play/README.txt"]!)).toMatch(/Play Console.*Phone screenshots/s);
    expect(strFromU8(zip["carousels/README.txt"]!)).toMatch(/upload the slides in this order.*Instagram crops every slide to the first one/s);
    const readme = strFromU8(zip["README.md"]!);
    expect(readme).toMatch(/Instagram crops every slide to the first one/);
    expect(readme).toMatch(/app-store\//);
    const manifest = JSON.parse(strFromU8(zip["manifest.json"]!)) as { compositions: { compositionId: string; still?: string; slides?: number }[] };
    expect(manifest.compositions.find((c) => c.compositionId === ios.id)).toMatchObject({ still: "store_ios", slides: 3 });
  });

  it("adds the AI-voice line to the copy of a video with an external TTS voice (X kept within 280)", () => {
    const long = "x".repeat(279);
    const pack = { id: "cp_x", channel: "x", locale: "en", items: [{ id: "i1", kind: "caption", text: long, claimIds: [] }, { id: "i2", kind: "hashtags", text: "#focus", claimIds: [] }] } as unknown as CopyPack;
    const out = withAiVoiceCopy(pack);
    expect(out.items[0]!.text.length).toBeLessThanOrEqual(280);
    expect(out.items[0]!.text.endsWith(AI_VOICE_CAPTION_LINE)).toBe(true);
    expect(out.items[1]!.text).toBe("#focus");
    // Once only.
    expect(withAiVoiceCopy(out).items[0]!.text).toBe(out.items[0]!.text);
    const ig = withAiVoiceCopy({ ...pack, channel: "instagram", items: [{ id: "i1", kind: "caption", text: "Mornings, sorted.", claimIds: [] }] } as unknown as CopyPack);
    expect(ig.items[0]!.text).toBe(`Mornings, sorted.\n\n${AI_VOICE_CAPTION_LINE}`);
    const doc = { audio: [{ kind: "voiceover", sourceLabel: "external_tts" }] } as unknown as CompositionDoc;
    expect(usesAiVoice(doc)).toBe(true);
    expect(usesAiVoice({ audio: [{ kind: "voiceover", sourceLabel: "founder_recording" }] } as unknown as CompositionDoc)).toBe(false);
  });
});
