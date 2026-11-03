import { readFileSync } from "node:fs";
import { handlers as analyticsHandlers, installAnalyticsHooks, installMemoryApi } from "@muselaunch/analytics";
import { createTestPlatform } from "@muselaunch/platform";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

/**
 * GET /apps/:appId/insights/results ("See what is working"): the daily series (real daily numbers
 * only), posts published (MuseLaunch's own records) and the best post (per-post numbers only).
 */

const fixture = (name: string) => readFileSync(new URL(`../../../../fixtures/analytics/${name}`, import.meta.url));

function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as J };
  };
  return { get: (path: string) => send("GET", path), post: (path: string, body?: unknown) => send("POST", path, body ?? {}) };
}

async function setup() {
  const p = createTestPlatform({}, { "app.import": async () => ({}), "media.probe": async () => ({}), ...analyticsHandlers });
  installAnalyticsHooks(p);
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id as string;
  const wsB = (await bob.post("/v1/workspaces", { name: "Bob Apps" })).body.workspace.id as string;
  const appId = (await alice.post(`/v1/workspaces/${wsA}/apps`, { appStoreUrl: "https://apps.apple.com/us/app/focusly/id123456789", websiteUrl: "https://focusly.app" })).body.app.id as string;
  const bobApp = (await bob.post(`/v1/workspaces/${wsB}/apps`, { appStoreUrl: "https://apps.apple.com/us/app/other/id987654321" })).body.app.id as string;
  await p.inline!.drain();
  const ws = p.db.ws(wsA);
  const campaign = await ws.collection("campaigns").create({ appId, name: "Launch week", goal: "awareness", status: "planning", channels: ["instagram"] }, { actor: "alice" });
  const W = `/v1/workspaces/${wsA}`;
  return { p, app, alice, bob, wsA, wsB, appId, bobApp, campaignId: campaign.id, ws, W, R: `${W}/apps/${appId}/insights/results` };
}

type Ctx = Awaited<ReturnType<typeof setup>>;

async function importCsv(ctx: Ctx, name: string) {
  const bytes = fixture(name);
  const up = await ctx.alice.post(`${ctx.W}/uploads`, { filename: name, mimeType: "text/csv", bytes: bytes.length, role: "document", appId: ctx.appId });
  await ctx.app.request(new URL(up.body.upload.url).pathname, { method: "PUT", headers: { "content-type": "text/csv" }, body: bytes });
  await ctx.alice.post(`${ctx.W}/assets/${up.body.asset.id}/complete`);
  await ctx.p.inline!.drain();
  const preview = await ctx.alice.post(`${ctx.W}/apps/${ctx.appId}/imports`, { assetId: up.body.asset.id });
  await ctx.alice.post(`${ctx.W}/imports/${preview.body.batch.id}/commit`);
  await ctx.p.inline!.drain();
}

/** A post that went out (marked as posted), with an image so it has a thumbnail. */
async function publishedPost(ctx: Ctx, opts: { title?: string; caption: string; publishedAt: string; channel?: "instagram" | "tiktok" | "youtube"; mode?: "api" | "manual_confirmed" }) {
  const image = await ctx.ws.collection("mediaAssets").create({ appId: ctx.appId, kind: "image", role: "screenshot", origin: "upload", storagePath: `x/${opts.caption.length}.png`, mimeType: "image/png", bytes: 1, status: "ready", isProductTruth: false }, { actor: "alice" });
  const channel = opts.channel ?? "instagram";
  const post = await ctx.ws.collection("scheduledPosts").create(
    { appId: ctx.appId, campaignId: ctx.campaignId, assetIds: [image.id], channel, mode: "manual", title: opts.title, caption: opts.caption, status: "manually_posted" },
    { actor: "alice" },
  );
  const pub = await ctx.ws.collection("publications").create(
    { appId: ctx.appId, campaignId: ctx.campaignId, scheduledPostId: post.id, channel, mode: opts.mode ?? "manual_confirmed", remoteUrl: `https://www.instagram.com/p/${post.id.slice(-8)}/`, publishedAt: opts.publishedAt },
    { actor: "alice" },
  );
  return { post, pub, image };
}

const postViews = (ctx: Ctx, publicationId: string, day: string, value: number) =>
  ctx.alice.post(`${ctx.W}/apps/${ctx.appId}/observations`, {
    metric: "views",
    value,
    windowStart: `${day}T00:00:00.000Z`,
    windowEnd: new Date(Date.parse(`${day}T00:00:00.000Z`) + 86_400_000).toISOString(),
    publicationId,
    attribution: "platform_reported",
    definition: "Instagram app insights, plays of this reel",
  });

afterAll(() => installMemoryApi(undefined));

describe("Results (GET /insights/results)", () => {
  it("a new app: no series, 0 posts published, no best post; another tenant can't read it", async () => {
    const ctx = await setup();
    const res = await ctx.alice.get(ctx.R);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ appId: ctx.appId, series: null, postsPublished: { value: 0, api: 0, manual: 0 }, bestPost: null });
    expect(res.body.range.timezone).toBe("UTC");
    expect((await ctx.bob.get(ctx.R)).status).toBe(404);
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsB}/apps/${ctx.appId}/insights/results`)).status).toBe(404);
    expect((await ctx.alice.get(`${ctx.W}/apps/${ctx.bobApp}/insights/results`)).status).toBe(404);
    expect((await ctx.alice.get(`${ctx.R}?from=nope`)).status).toBe(400);
  });

  it("imported daily views become the series, with the day the file had no number left as a gap", async () => {
    const ctx = await setup();
    await importCsv(ctx, "generic-wide.csv");
    const res = await ctx.alice.get(`${ctx.R}?from=2026-10-20&to=2026-10-26`);
    expect(res.status).toBe(200);
    const s = res.body.series;
    expect(s).toMatchObject({ metric: "views", label: "Views", measuredDays: 3, multiDayLeftOut: 0 });
    expect(s.points.slice(0, 5)).toEqual([
      { date: "2026-10-20", value: 3400 },
      { date: "2026-10-21", value: 2900 },
      { date: "2026-10-22", value: null },
      { date: "2026-10-23", value: 3100 },
      { date: "2026-10-24", value: null },
    ]);
    expect(s.points).toHaveLength(7);
    expect(s.sources).toEqual([{ source: "csv_import", label: "Imported CSV", imported: true, observationCount: 3 }]);
    // Account-wide numbers from a file never make a "best post".
    expect(res.body.bestPost).toBeNull();
  });

  it("counts posts published in the range and picks the post with the most views of its own", async () => {
    const ctx = await setup();
    const a = await publishedPost(ctx, { title: "Focus without the friction", caption: "Focus Mode blocks distractions.", publishedAt: "2026-10-21T10:00:00.000Z" });
    const b = await publishedPost(ctx, { caption: "One tap to deep work\nStart a focused session.", publishedAt: "2026-10-22T10:00:00.000Z", mode: "api" });
    await publishedPost(ctx, { caption: "Old post", publishedAt: "2026-09-01T10:00:00.000Z" });
    for (const [pub, day, v] of [
      [a.pub.id, "2026-10-21", 1800],
      [a.pub.id, "2026-10-22", 2400],
      [b.pub.id, "2026-10-22", 900],
    ] as const) {
      expect((await postViews(ctx, pub, day, v)).status).toBe(201);
    }
    const res = await ctx.alice.get(`${ctx.R}?from=2026-10-20&to=2026-10-26`);
    expect(res.body.postsPublished).toEqual({ value: 2, api: 1, manual: 1 });
    expect(res.body.bestPost).toMatchObject({
      publicationId: a.pub.id,
      scheduledPostId: a.post.id,
      channel: "instagram",
      title: "Focus without the friction",
      thumbnailAssetId: a.image.id,
      metric: "views",
      value: 4200,
      comparedPosts: 2,
      tiedWith: 0,
      attribution: "platform_reported",
    });
    expect(res.body.bestPost.sources).toEqual([{ source: "manual", label: "Manual entry", imported: true, observationCount: 2 }]);
    // Per-post daily numbers are also real daily numbers: they make the series (each day once).
    expect(res.body.series.points.slice(1, 3)).toEqual([
      { date: "2026-10-21", value: 1800 },
      { date: "2026-10-22", value: 3300 },
    ]);
    // A narrower range only counts what's inside it.
    const narrow = await ctx.alice.get(`${ctx.R}?from=2026-10-22&to=2026-10-22`);
    expect(narrow.body.postsPublished.value).toBe(1);
    expect(narrow.body.bestPost).toMatchObject({ publicationId: a.pub.id, value: 2400 });
  });
});
