import { sceneHash } from "@muselaunch/compositions";
import { installCampaignHooks } from "@muselaunch/agents";
import { fixtureJson, installFakeMeta, jsonRoute, requestText, resolvePlaceholders, seedApp } from "@muselaunch/agents/testing";
import { createTestPlatform } from "@muselaunch/platform";
import { handlers as workerHandlers } from "@muselaunch/worker/registry";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

// biome-ignore lint: loose JSON in tests
type J = any;

/**
 * Cross-module vertical slice with the REAL worker registry: B's storyboard.generate → C's
 * composition.build (buildFromStoryboard with the app's real screenshots) → B's composition.edit
 * via C's ai-edit route → C's apply. Meta responses are labelled fixtures; render.preview is stubbed.
 */
describe("B → C pipeline: storyboard → composition → AI scene edit → apply", () => {
  it("edits only the targeted scene of a composition built from a Spark storyboard", async () => {
    const p = createTestPlatform({ META_API_KEY: "test-key" }, { ...workerHandlers, "render.preview": async () => ({ creditsUsed: 0 }) });
    installCampaignHooks(p);
    const app = buildApp(p);
    const auth = { authorization: "Bearer dev:alice:alice@example.com", "content-type": "application/json" };
    const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: J }> => {
      const res = await app.request(path, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: res.status, body: await res.json() };
    };
    installFakeMeta(p, [
      jsonRoute("CampaignConcepts", (req) => resolvePlaceholders(fixtureJson("spark-concepts.json"), req)),
      jsonRoute("Storyboard", (req) => resolvePlaceholders(fixtureJson("spark-storyboard-repaired.json"), req)),
      jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) })),
      // Spark edit fixture built from the real describeForLLM text: retitle the first text layer of the requested scene.
      jsonRoute("CompositionEdit", (req) => {
        const text = requestText(req);
        const sceneId = text.match(/Edit ONLY these scenes: (\S+)/)![1]!;
        const block = text.split(`scene id=${sceneId} `)[1]!.split(/\n\s+\d+\. scene id=/)[0]!;
        const layerId = block.match(/layer id=(\S+) text/)![1]!;
        return { summary: "Sharper hook", targetSceneIds: [sceneId], ops: [{ op: "update_layer", sceneId, layerId, set: { text: "Where did your evening go?" } }] };
      }),
    ]);
    const wid = (await call("POST", "/v1/workspaces", { name: "Pipeline" })).body.workspace.id;
    const W = `/v1/workspaces/${wid}`;
    const seed = await seedApp(p, wid);

    const created = await call("POST", `${W}/apps/${seed.appId}/campaigns`, { request: "Three Reels for students", goal: "installs", channels: ["instagram"] });
    expect(created.status).toBe(202);
    await p.inline!.drain();
    const campaign = (await call("GET", `${W}/campaigns/${created.body.campaign.id}`)).body;
    // Spark's short name replaces the provisional one; the full request stays on the campaign.
    expect(campaign.campaign).toMatchObject({ name: "Calm focus for exam season", request: "Three Reels for students", status: "concepts_ready" });
    // Concepts cite the research findings they build on when research exists (none ran here → none cited, honestly).
    for (const v of campaign.variants) expect(v.findingIds).toEqual([]);
    const variant = campaign.variants.find((v: J) => v.angleType === "practical_demo");
    expect((await call("POST", `${W}/campaigns/${campaign.campaign.id}/variants/${variant.id}/produce`, { aspectRatio: "9:16", targetDurationSec: 15 })).status).toBe(202);
    await p.inline!.drain();
    // storyboard → build → preview finished → the campaign leaves "producing" (status hook).
    expect(await p.db.ws(wid).collection("campaigns").getOrThrow(campaign.campaign.id)).toMatchObject({ status: "review" });
    expect((await p.db.ws(wid).collection("campaignVariants").getOrThrow(variant.id)).status).toBe("produced");

    const after = (await call("GET", `${W}/campaigns/${campaign.campaign.id}`)).body;
    expect(after.compositions).toHaveLength(1);
    const compId = after.compositions[0].id;
    const comp = (await call("GET", `${W}/compositions/${compId}`)).body;
    const doc = comp.version?.doc ?? comp.doc;
    expect(doc.scenes.length).toBe(4);
    // The demo scene shows the app's REAL screenshot inside a device frame.
    const deviceScreens = doc.scenes.flatMap((s: J) => s.layers.filter((l: J) => l.type === "device").map((l: J) => l.screenAssetId));
    expect(deviceScreens.length).toBeGreaterThan(0);
    for (const id of deviceScreens) expect(seed.screenshotIds).toContain(id);

    const target = doc.scenes[0].id;
    const edit = await call("POST", `${W}/compositions/${compId}/ai-edit`, { baseVersion: comp.composition?.currentVersion ?? 1, instruction: "Make the opening more engaging", sceneIds: [target] });
    expect(edit.status).toBe(202);
    await p.inline!.drain();
    const patch = (await call("GET", `${W}/compositions/${compId}/patches/${edit.body.patch.id}`)).body.patch;
    expect(patch).toMatchObject({ status: "proposed", affectedSceneIds: [target], summary: "Sharper hook" });
    expect(patch.agentRunId).toMatch(/^run_/);
    const applied = await call("POST", `${W}/compositions/${compId}/patches/${patch.id}/apply`);
    expect(applied.status).toBe(200);
    const v2 = applied.body.version.doc;
    expect(JSON.stringify(v2.scenes[0])).toContain("Where did your evening go?");
    for (let i = 1; i < doc.scenes.length; i++) expect(sceneHash(v2.scenes[i])).toBe(sceneHash(doc.scenes[i]));
    const run = (await call("GET", `${W}/agent-runs/${patch.agentRunId}`)).body;
    expect(run.run.kind).toBe("scene_edit");
    expect(run.usage.some((u: J) => u.task === "composition.edit")).toBe(true);
  });
});
