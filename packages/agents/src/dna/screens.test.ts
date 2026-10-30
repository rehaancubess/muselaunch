import type { JobPayload } from "@muselaunch/contracts";
import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { handlers } from "../index";
import { fixtureJson, installFakeMeta, jsonRoute, resolvePlaceholders, seedApp } from "../testing";

describe("App DNA → screen cut-outs", () => {
  it("queues media.extract_ui after the analysis for screenshots that still need checking, with credits per screenshot", async () => {
    const seen: JobPayload<"media.extract_ui">[] = [];
    const p = createTestPlatform({ META_API_KEY: "test-key" }, { ...handlers, "media.extract_ui": async (ctx) => void seen.push(ctx.payload) });
    installFakeMeta(p, [jsonRoute("AppDna", (req) => resolvePlaceholders(fixtureJson("spark-app-dna.json"), req))]);
    const wid = "ws_dna_screens";
    await p.credits.ensureAccount(wid, { grant: 200, reason: "test" });
    const seed = await seedApp(p, wid);
    const ws = p.db.ws(wid);

    const first = await p.jobs.create(wid, "app.analyze", { appId: seed.appId }, { actor: "u1", appId: seed.appId, credits: { operation: "app.analyze" } });
    await p.inline!.drain();
    const done = (await p.jobs.get(wid, first.id))!;
    expect(done.status).toBe("succeeded");
    const cutJob = (await p.jobs.get(wid, String(done.output?.data?.screenCutoutJobId)))!;
    expect(cutJob).toMatchObject({ type: "media.extract_ui", parentJobId: first.id, status: "succeeded", reservation: { credits: 4 } }); // 2 screenshots × 2
    expect(seen).toEqual([{ appId: seed.appId }]);

    // Raw screens and store images that already have a cut-out need nothing: no job, no charge.
    const [a, b] = seed.screenshotIds;
    await ws.collection("mediaAssets").update(a!, { screenshotKind: "raw_ui" }, { actor: "t" });
    await ws.collection("mediaAssets").update(b!, { screenshotKind: "marketing" }, { actor: "t" });
    const orig = await ws.collection("mediaAssets").getOrThrow(b!);
    await ws.collection("mediaAssets").create(
      { appId: seed.appId, kind: "image", role: "screenshot", origin: "derived", storagePath: `${orig.storagePath}.crop.png`, mimeType: "image/png", status: "ready", isProductTruth: true, sourceLabel: "sam_ui_crop", derivedFromAssetId: b!, screenshotKind: "raw_ui" },
      { actor: "t" },
    );
    const again = await p.jobs.create(wid, "app.analyze", { appId: seed.appId, refresh: true }, { actor: "u1", appId: seed.appId, credits: { operation: "app.analyze" } });
    await p.inline!.drain();
    const second = (await p.jobs.get(wid, again.id))!;
    expect(second.status).toBe("succeeded");
    expect(second.output?.data?.screenCutoutJobId).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("never blocks App DNA when there are no credits left for the cut-outs", async () => {
    const p = createTestPlatform({ META_API_KEY: "test-key" }, handlers);
    installFakeMeta(p, [jsonRoute("AppDna", (req) => resolvePlaceholders(fixtureJson("spark-app-dna.json"), req))]);
    const wid = "ws_dna_screens_poor";
    await p.credits.ensureAccount(wid, { grant: 15, reason: "test" }); // exactly one App DNA analysis
    const seed = await seedApp(p, wid);
    const job = await p.jobs.create(wid, "app.analyze", { appId: seed.appId }, { actor: "u1", appId: seed.appId, credits: { operation: "app.analyze" } });
    await p.inline!.drain();
    const done = (await p.jobs.get(wid, job.id))!;
    expect(done.status).toBe("succeeded");
    expect(done.output?.data?.screenCutoutJobId).toBeUndefined();
    const log = await p.jobs.listEvents(wid, job.id);
    expect(log.some((e) => /Screen cut-outs not started/.test(e.message ?? ""))).toBe(true);
  });
});
