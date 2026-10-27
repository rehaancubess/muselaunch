import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { App, CompositionDoc, MediaAsset, Storyboard } from "@muselaunch/contracts";
import { buildFromStoryboard, sceneHash } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { createTestPlatform, workspaceKey } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

const FIXTURES = fileURLToPath(new URL("../../../fixtures/render/", import.meta.url));

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as J });
  return {
    get: (path: string) => app.request(path, { headers: auth }).then(json),
    post: (path: string, body?: unknown) =>
      app.request(path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? "{}" : JSON.stringify(body) }).then(json),
  };
}

describe("composition routes", () => {
  // composition.edit belongs to module B; this stand-in fills the proposed patch the way B's handler will,
  // so the route's propose → poll → apply flow can be exercised end to end.
  const p = createTestPlatform(
    {},
    {
      "composition.edit": async (ctx) => {
        const patches = ctx.ws.collection("compositionPatches");
        await patches.update(
          ctx.payload.patchId,
          { ops: [{ op: "update_layer", sceneId: "sc_s2", layerId: "sc_s2_headline", set: { text: "One tap. Whole day planned." } }], summary: "Punchier demo headline" },
          { actor: ctx.actor },
        );
        return { refs: [{ entity: "compositionPatches", id: ctx.payload.patchId }], creditsUsed: 1 };
      },
    },
  );
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  let wid = "";
  let widBob = "";
  let compId = "";
  let doc: CompositionDoc;

  it("sets up a workspace with an app, real screenshot assets and a composition", async () => {
    wid = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    widBob = (await bob.post("/v1/workspaces", { name: "Bob" })).body.workspace.id;
    const ws = p.db.ws(wid);
    const now = new Date().toISOString();
    const appDoc = (await ws.collection("apps").create({ name: "Focusly", platforms: ["ios"], storeUrls: {}, status: "ready", dnaStatus: "confirmed", targetCountries: [], targetLanguages: ["en"] }, { actor: "alice" })) as App;
    const assets: MediaAsset[] = [];
    for (const [id, file] of [
      ["ast_shot_today", "screenshot-today.png"],
      ["ast_icon", "app-icon.png"],
    ] as const) {
      const key = workspaceKey(wid, "uploads", id, file);
      const put = await p.storage.put(key, readFileSync(join(FIXTURES, file)), { contentType: "image/png" });
      assets.push(
        await ws.collection("mediaAssets").create(
          { id, appId: appDoc.id, kind: "image", role: id === "ast_icon" ? "icon" : "screenshot", origin: "upload", storagePath: key, mimeType: "image/png", bytes: put.bytes, width: 1179, height: 2556, status: "ready", isProductTruth: id !== "ast_icon" },
          { actor: "alice" },
        ),
      );
    }
    await ws.collection("apps").update(appDoc.id, { iconAssetId: "ast_icon" }, { actor: "alice" });
    const storyboard = {
      id: "sbd_1",
      workspaceId: wid,
      createdAt: now,
      updatedAt: now,
      createdBy: "alice",
      appId: appDoc.id,
      campaignId: "cpg_1",
      variantId: "var_1",
      title: "Mornings",
      aspectRatio: "9:16",
      targetDurationSec: 9,
      scenes: [
        { id: "s1", order: 0, purpose: "hook", durationSec: 2.5, onScreenText: "Your mornings deserve better", narration: "", visual: "", template: "hook-title", assets: [], claimIds: [] },
        { id: "s2", order: 1, purpose: "demo", durationSec: 3.5, onScreenText: "Plan your day in focus blocks", narration: "", visual: "", template: "device-demo", assets: [{ kind: "screenshot", assetId: "ast_shot_today" }], claimIds: [] },
        { id: "s3", order: 2, purpose: "cta", durationSec: 3, onScreenText: "Try Focusly free", narration: "", visual: "", template: "cta-endcard", assets: [], claimIds: [] },
      ],
      voiceover: { source: "none" },
      music: {},
    } as unknown as Storyboard;
    doc = buildFromStoryboard({ storyboard, app: { ...appDoc, iconAssetId: "ast_icon" }, brand: null, assets });
    const created = await createComposition(ws, { appId: appDoc.id, campaignId: "cpg_1", title: "Mornings", doc }, "alice");
    compId = created.composition.id;
    await ws.collection("campaigns").create({ id: "cpg_1", appId: appDoc.id, name: "Launch", goal: "launch", channels: ["instagram"] }, { actor: "alice" });
  });

  it("returns the composition with its current version and lint", async () => {
    const r = await alice.get(`/v1/workspaces/${wid}/compositions/${compId}`);
    expect(r.status).toBe(200);
    expect(r.body.composition.currentVersion).toBe(1);
    expect(r.body.version.doc.scenes).toHaveLength(3);
    expect(r.body.lint.filter((i: J) => i.level === "error")).toEqual([]);
    expect(r.body.durationSec).toBe(9);
    const list = await alice.get(`/v1/workspaces/${wid}/compositions?campaignId=cpg_1`);
    expect(list.body.items.map((x: J) => x.id)).toEqual([compId]);
  });

  it("serves preview HTML with short-lived signed asset URLs only", async () => {
    const r = await alice.get(`/v1/workspaces/${wid}/compositions/${compId}/preview`);
    expect(r.status).toBe(200);
    expect(r.body.version).toBe(1);
    expect(r.body.durationSec).toBe(9);
    expect(r.body.html).toContain('data-composition-id="muselaunch"');
    expect(r.body.html).toContain("/v1/storage/local/");
    expect(r.body.html).not.toContain(`workspaces/${wid}/uploads`);
    expect(r.body.missingAssetIds).toEqual([]);
    const signed = /src="(http:\/\/localhost:8080\/v1\/storage\/local\/[^"]+)"/.exec(r.body.html)![1]!;
    const img = await app.request(new URL(signed.replace(/&amp;/g, "&")).pathname);
    expect(img.status).toBe(200);
  });

  it("applies a scene-scoped patch, leaving other scenes byte-identical; rejects stale and invalid patches", async () => {
    const ok = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/patch`, {
      baseVersion: 1,
      ops: [{ op: "update_layer", sceneId: "sc_s2", layerId: "sc_s2_headline", set: { text: "Your day, in focus blocks" } }],
      summary: "Edit headline",
    });
    expect(ok.status).toBe(200);
    expect(ok.body.version.version).toBe(2);
    expect(ok.body.affectedSceneIds).toEqual(["sc_s2"]);
    expect(ok.body.version.sceneHashes.sc_s1).toBe(sceneHash(doc.scenes[0]!));
    expect(ok.body.version.sceneHashes.sc_s3).toBe(sceneHash(doc.scenes[2]!));
    expect(ok.body.version.sceneHashes.sc_s2).not.toBe(sceneHash(doc.scenes[1]!));
    expect(ok.body.patch.status).toBe("applied");

    const stale = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/patch`, { baseVersion: 1, ops: [{ op: "remove_scene", sceneId: "sc_s3" }] });
    expect(stale.status).toBe(409);
    const bad = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/patch`, { baseVersion: 2, ops: [{ op: "update_layer", sceneId: "sc_s2", layerId: "nope", set: { text: "x" } }] });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.errors[0]).toMatch(/unknown layer/);
  });

  it("undoes and redoes", async () => {
    const u = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/undo`);
    expect(u.body.composition.currentVersion).toBe(1);
    expect(u.body.version.doc.scenes[1].layers.find((l: J) => l.id === "sc_s2_headline").text).toBe("Plan your day in focus blocks");
    const r = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/redo`);
    expect(r.body.composition.currentVersion).toBe(2);
    expect((await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/redo`)).status).toBe(409);
    const versions = await alice.get(`/v1/workspaces/${wid}/compositions/${compId}/versions`);
    expect(versions.body.items.map((v: J) => v.version)).toEqual([2, 1]);
    expect(versions.body.items[0].doc).toBeUndefined();
    expect((await alice.get(`/v1/workspaces/${wid}/compositions/${compId}/versions/1`)).body.version.version).toBe(1);
  });

  it("runs the AI edit flow: propose (202) → job fills ops → preview → apply", async () => {
    const before = (await alice.get(`/v1/workspaces/${wid}/billing/credits`)).body.balance.available;
    const r = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/ai-edit`, { baseVersion: 2, instruction: "Make scene 2 punchier", sceneIds: ["sc_s2"] });
    expect(r.status).toBe(202);
    expect(r.body.patch.status).toBe("proposed");
    expect(r.body.patch.ops).toEqual([]);
    expect(r.body.job.type).toBe("composition.edit");
    expect(r.body.job.payload).toMatchObject({ compositionId: compId, baseVersion: 2, patchId: r.body.patch.id, sceneIds: ["sc_s2"], autoApply: false });
    expect(r.body.job.reservation.credits).toBeGreaterThan(0);
    const early = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/patches/${r.body.patch.id}/apply`);
    expect([200, 409]).toContain(early.status); // inline jobs may already have finished
    await p.inline!.drain();
    const got = await alice.get(`/v1/workspaces/${wid}/compositions/${compId}/patches/${r.body.patch.id}`);
    expect(got.body.patch.ops).toHaveLength(1);
    expect(got.body.preview).toEqual({ applicable: true, affectedSceneIds: ["sc_s2"], errors: [] });
    const applied = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/patches/${r.body.patch.id}/apply`);
    expect(applied.status).toBe(200);
    expect(applied.body.version.version).toBe(3);
    expect(applied.body.version.source).toBe("ai_edit");
    expect(applied.body.patch.status).toBe("applied");
    const after = (await alice.get(`/v1/workspaces/${wid}/billing/credits`)).body.balance.available;
    expect(before - after).toBe(1);
    const unknownScene = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/ai-edit`, { baseVersion: 3, instruction: "x", sceneIds: ["sc_nope"] });
    expect(unknownScene.status).toBe(400);
  });

  it("rejects a proposed patch", async () => {
    const r = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/ai-edit`, { baseVersion: 3, instruction: "Try something else" });
    await p.inline!.drain();
    const rej = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/patches/${r.body.patch.id}/reject`);
    expect(rej.body.patch.status).toBe("rejected");
    expect((await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/patches/${r.body.patch.id}/apply`)).status).toBe(409);
    const list = await alice.get(`/v1/workspaces/${wid}/compositions/${compId}/patches`);
    expect(list.body.items.length).toBeGreaterThanOrEqual(3);
  });

  it("queues a final render with a credit hold sized by duration; failures release it", async () => {
    const before = (await alice.get(`/v1/workspaces/${wid}/billing/credits`)).body.balance.available;
    const r = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/render`, { quality: "final" });
    expect(r.status).toBe(202);
    expect(r.body.job.type).toBe("render.final");
    expect(r.body.job.payload).toMatchObject({ compositionId: compId, version: 3, format: "mp4" });
    expect(r.body.job.reservation.credits).toBe(r.body.estimate.credits);
    expect(r.body.estimate.credits).toBe(8); // 9 s → one 15 s block
    await p.inline!.drain(); // no render worker registered in this test → job fails → hold released
    const job = (await alice.get(`/v1/workspaces/${wid}/jobs/${r.body.job.id}`)).body.job;
    expect(job.status).toBe("failed");
    expect((await alice.get(`/v1/workspaces/${wid}/billing/credits`)).body.balance.available).toBe(before);
    const preview = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/render`, { quality: "preview" });
    expect(preview.body.job.type).toBe("render.preview");
  });

  it("blocks a final render when the doc uses unverified claims", async () => {
    const ws = p.db.ws(wid);
    const comp = await ws.collection("compositions").getOrThrow(compId);
    const claim = await ws.collection("claims").create({ appId: comp.appId, text: "Saves 2 hours a day", confidence: 0.5, state: "needs_review", origin: "agent" }, { actor: "alice" });
    const patched = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/patch`, { baseVersion: 3, ops: [{ op: "update_layer", sceneId: "sc_s1", layerId: "sc_s1_headline", set: { claimIds: [claim.id] } }] });
    expect(patched.status).toBe(200);
    const r = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/render`, { quality: "final" });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.body.error.details.issues)).toMatch(/needs review/);
    await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/undo`);
  });

  it("queues variants and the export package", async () => {
    const v = await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/variants`, { mode: "aspect", targets: ["1:1", "16:9"] });
    expect(v.status).toBe(202);
    expect(v.body.job.type).toBe("composition.variants");
    expect((await alice.post(`/v1/workspaces/${wid}/compositions/${compId}/variants`, { mode: "aspect", targets: ["3:2"] })).status).toBe(422);
    const e = await alice.post(`/v1/workspaces/${wid}/campaigns/cpg_1/export`, { includeCopy: true });
    expect(e.status).toBe(202);
    expect(e.body.job.type).toBe("package.export");
  });

  it("enforces tenancy and capabilities", async () => {
    expect((await bob.get(`/v1/workspaces/${wid}/compositions/${compId}`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${widBob}/compositions/${compId}`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${widBob}/compositions/${compId}/preview`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${widBob}/compositions/${compId}/undo`)).status).toBe(404);
    const inv = (await alice.post(`/v1/workspaces/${wid}/invites`, { email: "vic@example.com", role: "viewer" })).body;
    const vic = client(app, "vic", "vic@example.com");
    await vic.post(`/v1/invites/${inv.acceptUrl.split("/").pop()}/accept`);
    expect((await vic.get(`/v1/workspaces/${wid}/compositions/${compId}`)).status).toBe(200);
    expect((await vic.post(`/v1/workspaces/${wid}/compositions/${compId}/patch`, { baseVersion: 3, ops: [{ op: "remove_scene", sceneId: "sc_s3" }] })).status).toBe(403);
    expect((await vic.post(`/v1/workspaces/${wid}/compositions/${compId}/render`, { quality: "final" })).status).toBe(403);
  });
});
