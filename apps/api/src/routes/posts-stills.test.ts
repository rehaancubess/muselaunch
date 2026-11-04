import { configureGrowth, handlers as growthHandlers } from "@muselaunch/growth";
import { createTestPlatform, workspaceKey } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app";

/**
 * Carousel and text posts through the API (routes/publishing.ts → growth/publishing/posts.ts):
 * POST /apps/:appId/posts with a still composition (every slide, in order) or a copy pack only
 * (text post), GET /posts/:id `media` for previews, GET /publishing/channel-rules, and tenancy.
 * No provider is configured here, so every post is manual (nothing is published).
 */

type J = any;
function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as J };
  };
  return { get: (path: string) => send("GET", path), post: (path: string, body?: unknown) => send("POST", path, body ?? {}), patch: (path: string, body: unknown) => send("PATCH", path, body) };
}

describe("Carousel and text posts (API)", () => {
  const p = createTestPlatform({}, growthHandlers);
  configureGrowth(p, { fetch: async () => new Response("{}", { status: 599 }), sleep: async () => {}, claimValidator: null, settings: { creds: {} } });
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");

  it("creates a carousel post with all slides, previews them, a text post from a copy pack, and keeps other workspaces out", async () => {
    const wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    const wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).body.workspace.id;
    const A = `/v1/workspaces/${wsA}`;
    const appId = (await alice.post(`${A}/apps`, { name: "Fixture Planner" })).body.app.id;
    const ws = p.db.ws(wsA);
    const campaignId = (await ws.collection("campaigns").create({ appId, name: "Launch", goal: "launch" }, { actor: "alice" })).id;
    const comp = await ws.collection("compositions").create({ appId, campaignId, title: "Carousel", kind: "carousel", aspectRatio: "4:5", currentVersion: 1, latestVersion: 1 }, { actor: "alice" });
    const key = "kcarousel0000000000000001";
    for (let i = 1; i <= 4; i++) {
      const storagePath = workspaceKey(wsA, "renders", comp.id, `v1-final-slide${i}.jpg`);
      await p.storage.put(storagePath, Buffer.from(`slide ${i}`), { contentType: "image/jpeg" });
      await ws.collection("mediaAssets").create(
        { id: i === 1 ? `ast_r_${key}` : `ast_r_${key}_${i}`, appId, campaignId, kind: "image", role: "render", origin: "render", storagePath, mimeType: "image/jpeg", bytes: 7, width: 1080, height: 1350, status: "ready", labels: [`slide:${i}`], render: { compositionId: comp.id, version: 1, quality: "final" } },
        { actor: "alice" },
      );
    }
    const slides = [`ast_r_${key}`, `ast_r_${key}_2`, `ast_r_${key}_3`, `ast_r_${key}_4`];

    const created = await alice.post(`${A}/apps/${appId}/posts`, { campaignId, compositionId: comp.id, channel: "instagram", caption: "Four ways to plan your week" });
    expect(created.status).toBe(201);
    expect(created.body.post).toMatchObject({ assetIds: slides, mode: "manual", compositionVersion: 1 });
    expect(created.body.post.manualInstructions.join(" ")).toMatch(/Pick the slides in order, 1 to 4/);

    const view = (await alice.get(`${A}/posts/${created.body.post.id}`)).body;
    expect(view.media).toMatchObject({ shape: "carousel", count: 4, rules: { channel: "instagram", needsMedia: true, api: { carousel: { min: 2, max: 10, mimeTypes: ["image/jpeg"] }, imageFormats: ["JPEG"] } } });
    expect(view.media.items.map((i: J) => [i.order, i.slide, i.assetId])).toEqual(slides.map((id, i) => [i + 1, i + 1, id]));
    const manual = (await alice.get(`${A}/posts/${created.body.post.id}/manual`)).body;
    expect(manual.downloads.map((d: J) => d.filename)).toEqual(["instagram-slide-01.jpg", "instagram-slide-02.jpg", "instagram-slide-03.jpg", "instagram-slide-04.jpg"]);

    // Text post: a copy pack for the channel, no composition, no media.
    const pack = await ws.collection("copyPacks").create({ appId, campaignId, channel: "linkedin", items: [{ id: "it_1", kind: "caption", text: "What I learned shipping a planner in 30 days.", claimIds: [] }], validation: { ok: true, issues: [], checkedAt: new Date().toISOString() } }, { actor: "alice" });
    const text = await alice.post(`${A}/apps/${appId}/posts`, { campaignId, copyPackId: pack.id, channel: "linkedin" });
    expect(text.status).toBe(201);
    expect(text.body.post).toMatchObject({ assetIds: [], caption: "What I learned shipping a planner in 30 days.", mode: "manual" });
    expect(text.body.preflight.errors).toEqual([]);
    expect((await alice.get(`${A}/posts/${text.body.post.id}`)).body.media).toMatchObject({ shape: "text", count: 0 });
    expect((await alice.post(`${A}/posts/${text.body.post.id}/package`)).status).toBe(400);
    const list = (await alice.get(`${A}/apps/${appId}/posts`)).body.items;
    expect(list.find((x: J) => x.id === text.body.post.id)).toMatchObject({ textOnly: true, mediaCount: 0 });
    expect(list.find((x: J) => x.id === created.body.post.id)).toMatchObject({ textOnly: false, mediaCount: 4 });
    // Nothing at all to post is refused by the request schema.
    expect((await alice.post(`${A}/apps/${appId}/posts`, { campaignId, channel: "x", caption: "x" })).status).toBe(422);

    const rules = (await alice.get(`${A}/publishing/channel-rules`)).body.items;
    expect(rules.find((r: J) => r.channel === "x")).toMatchObject({ needsMedia: false, captionLimit: 280, manualMaxImages: 4, api: { textOnly: true, carousel: { min: 2, max: 4 } } });
    expect(rules.find((r: J) => r.channel === "tiktok").api).toMatchObject({ carousel: null, manualReason: { carousel: expect.stringMatching(/verified with TikTok/) } });
    expect(rules.find((r: J) => r.channel === "threads")).toMatchObject({ api: null, manualMaxImages: 20, captionLimit: 500 });

    // Tenancy: Bob's workspace can't see or use Alice's composition or posts.
    const B = `/v1/workspaces/${wsB}`;
    expect((await bob.get(`${B}/posts/${created.body.post.id}`)).status).toBe(404);
    expect((await bob.post(`${A}/apps/${appId}/posts`, { campaignId, compositionId: comp.id, channel: "x", caption: "x" })).status).toBe(404);
  });
});
