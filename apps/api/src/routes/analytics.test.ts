import { readFileSync } from "node:fs";
import { fallbackMemoryApi, handlers as analyticsHandlers, installAnalyticsHooks, installMemoryApi, installRevenueCatFetch } from "@muselaunch/analytics";
import { AppError, BALANCE_KEY, createTestPlatform, type HandlerRegistry } from "@muselaunch/platform";
import { CreditBalance } from "@muselaunch/contracts";
import { installMetaClient, MetaClient } from "@muselaunch/providers";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../app";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

const fixture = (name: string) => readFileSync(new URL(`../../../../fixtures/analytics/${name}`, import.meta.url));
const fixtureJson = (name: string) => JSON.parse(fixture(name).toString("utf8")) as { response: unknown; status?: number };

function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as J };
  };
  return {
    get: (path: string) => send("GET", path),
    post: (path: string, body?: unknown) => send("POST", path, body ?? {}),
    patch: (path: string, body: unknown) => send("PATCH", path, body),
    del: (path: string) => send("DELETE", path),
  };
}

/** Fake RevenueCat v2 following the documented shapes (fixtures, not live). */
function fakeRevenueCat(goodKey = "sk_good_test_key") {
  const calls: string[] = [];
  const f = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    const auth = new Headers(init?.headers).get("authorization");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (auth !== `Bearer ${goodKey}`) return json(fixtureJson("revenuecat-error-403.json").response, 403);
    if (url.pathname === "/v2/projects") return json({ object: "list", items: [{ object: "project", id: "proj_test", name: "Focusly" }], url: "/v2/projects" });
    if (url.pathname === "/v2/projects/proj_test/metrics/overview") return json(fixtureJson("revenuecat-overview.json").response);
    const chart = /^\/v2\/projects\/proj_test\/charts\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (chart) return json(fixtureJson(`revenuecat-chart-${chart}.json`).response);
    return json({ type: "resource_missing", message: "not found" }, 404);
  }) as unknown as typeof fetch;
  return { f, calls };
}

/** Fake Meta Responses API returning queued structured outputs (documented shape). */
function fakeMeta(texts: string[]) {
  const requests: J[] = [];
  const f = (async (_url: string, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)));
    const text = texts[Math.min(requests.length - 1, texts.length - 1)]!;
    const body = { id: `resp_fixture_${requests.length}`, model: requests.at(-1).model, status: "completed", output: [{ type: "message", content: [{ type: "output_text", text, annotations: [] }] }], usage: { input_tokens: 900, output_tokens: 200 } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { f, requests };
}

async function setup(extraHandlers: HandlerRegistry = {}) {
  const p = createTestPlatform({}, { "app.import": async () => ({}), "media.probe": async () => ({}), ...analyticsHandlers, ...extraHandlers });
  installAnalyticsHooks(p);
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id as string;
  const wsB = (await bob.post("/v1/workspaces", { name: "Bob Apps" })).body.workspace.id as string;
  const created = await alice.post(`/v1/workspaces/${wsA}/apps`, { appStoreUrl: "https://apps.apple.com/us/app/focusly/id123456789", websiteUrl: "https://focusly.app" });
  const appId = created.body.app.id as string;
  await p.inline!.drain();
  const campaign = await p.db.ws(wsA).collection("campaigns").create({ appId, name: "Launch week", goal: "awareness", status: "planning", channels: ["tiktok"] }, { actor: "alice" });
  return { p, app, alice, bob, wsA, wsB, appId, campaignId: campaign.id };
}

async function uploadCsv(ctx: Awaited<ReturnType<typeof setup>>, name: string, mimeType = "text/csv") {
  const bytes = fixture(name);
  const up = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/uploads`, { filename: name, mimeType, bytes: bytes.length, role: "document", appId: ctx.appId });
  expect(up.status).toBe(201);
  const put = await ctx.app.request(new URL(up.body.upload.url).pathname, { method: "PUT", headers: { "content-type": mimeType }, body: bytes });
  expect(put.status).toBe(200);
  await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/assets/${up.body.asset.id}/complete`);
  await ctx.p.inline!.drain();
  return up.body.asset.id as string;
}

afterAll(() => {
  installMemoryApi(undefined);
  delete process.env.ADMIN_UIDS;
});

describe("Insights overview", () => {
  it("never fabricates: a new app shows every metric as missing with a reason and an action", async () => {
    const ctx = await setup();
    const res = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview`);
    expect(res.status).toBe(200);
    expect(res.body.metrics.every((m: J) => m.value === null && m.sources.length === 0)).toBe(true);
    const missing = Object.fromEntries(res.body.missing.map((m: J) => [m.metric, m]));
    expect(missing.revenue.action).toBe("connect_revenuecat");
    expect(missing.installs.action).toBe("import_csv");
    expect(missing.views).toMatchObject({ action: "publish_post", reason: "No published posts yet." });
    expect(missing.clicks.action).toBe("create_tracked_link");
    expect(res.body.funnel.every((s: J) => s.value === null && s.conversionFromPrevious === null)).toBe(true);
    expect(res.body.cost.costs.adSpend).toBeNull();
    expect(res.body.cost.unknowns).toContain("Ad spend: not imported.");
    expect(res.body.disclaimers.join(" ")).toMatch(/correlation, not proof/);
    // tenancy
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview`)).status).toBe(404);
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsB}/apps/${ctx.appId}/insights/overview`)).status).toBe(404);
  });
});

describe("CSV import", () => {
  it("previews a mapping with rejected rows, commits observations labelled Imported, and is idempotent on re-import", async () => {
    const ctx = await setup();
    const assetId = await uploadCsv(ctx, "generic-wide.csv");
    const preview = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/imports`, { assetId });
    expect(preview.status).toBe(201);
    const batch = preview.body.batch;
    expect(batch).toMatchObject({ status: "parsed", detectedFormat: "generic_wide", kind: "csv" });
    expect(batch.mapping["Revenue (USD)"]).toBe("metric:revenue#USD");
    expect(batch.rejected.length).toBeGreaterThanOrEqual(2);
    expect(batch.preview.length).toBeGreaterThan(0);
    // nothing written before commit
    expect((await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/observations`)).body.items).toHaveLength(0);

    const commit = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/imports/${batch.id}/commit`);
    expect(commit.status).toBe(202);
    await ctx.p.inline!.drain();
    const done = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/imports/${batch.id}`);
    expect(done.body.batch.status).toBe("committed");
    const obs = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/observations?metric=installs`)).body.items;
    expect(obs).toHaveLength(3);
    expect(obs.every((o: J) => o.provenance.imported === true && o.source === "csv_import" && o.provenance.importId === batch.id && o.attribution === "aggregate")).toBe(true);

    const ov = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview?from=2026-10-20&to=2026-10-26&compare=none`);
    const installs = ov.body.metrics.find((m: J) => m.metric === "installs");
    expect(installs).toMatchObject({ value: 323, imported: true, attribution: "aggregate", aggregation: "sum" });
    expect(installs.sources[0].label).toBe("Imported CSV");
    expect(installs.coverage).toEqual({ daysWithData: 3, daysInRange: 7 });
    expect(ov.body.missing.map((m: J) => m.metric)).not.toContain("installs");
    expect(ov.body.missing.map((m: J) => m.metric)).toContain("mrr");

    // Re-importing the same file upserts (no double counting)
    const again = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/imports`, { assetId });
    await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/imports/${again.body.batch.id}/commit`);
    await ctx.p.inline!.drain();
    const ov2 = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview?from=2026-10-20&to=2026-10-26&compare=none`);
    expect(ov2.body.metrics.find((m: J) => m.metric === "installs").value).toBe(323);

    // Another tenant can't read or commit it
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsB}/imports/${batch.id}`)).status).toBe(404);
    expect((await ctx.bob.post(`/v1/workspaces/${ctx.wsA}/imports/${batch.id}/commit`)).status).toBe(404);
  });

  it("fails visibly when no rows are valid, and refuses non-CSV assets", async () => {
    const ctx = await setup();
    const bad = Buffer.from("Date,Mood\n2026-10-20,happy\n");
    const up = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/uploads`, { filename: "mood.csv", mimeType: "text/csv", bytes: bad.length, role: "document", appId: ctx.appId });
    await ctx.app.request(new URL(up.body.upload.url).pathname, { method: "PUT", headers: { "content-type": "text/csv" }, body: bad });
    await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/assets/${up.body.asset.id}/complete`);
    const preview = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/imports`, { assetId: up.body.asset.id });
    expect(preview.body.warnings.join(" ")).toMatch(/No column is mapped/);
    const commit = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/imports/${preview.body.batch.id}/commit`);
    await ctx.p.inline!.drain();
    const job = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/jobs/${commit.body.job.id}`)).body.job;
    expect(job.status).toBe("failed");
    expect(job.error.code).toBe("VALIDATION_FAILED");
    expect((await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/imports/${preview.body.batch.id}`)).body.batch.status).toBe("failed");
  });

  it("records manual entries labelled Manual and refuses link/direct attribution", async () => {
    const ctx = await setup();
    const res = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/observations`, {
      metric: "views",
      value: 1200,
      windowStart: "2026-10-20T00:00:00Z",
      windowEnd: "2026-10-21T00:00:00Z",
      channel: "instagram",
      definition: "Instagram app insights: reel plays",
    });
    expect(res.status).toBe(201);
    expect(res.body.observation).toMatchObject({ source: "manual", attribution: "aggregate", provenance: { imported: true } });
    const bad = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/observations`, { metric: "views", value: 1, windowStart: "2026-10-20T00:00:00Z", windowEnd: "2026-10-21T00:00:00Z", attribution: "link", definition: "x y z" });
    expect(bad.status).toBe(422);
    const ov = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview?from=2026-10-20&to=2026-10-20&compare=none`);
    expect(ov.body.metrics.find((m: J) => m.metric === "views")).toMatchObject({ value: 1200, imported: true });
    expect(ov.body.metrics.find((m: J) => m.metric === "views").sources[0].label).toBe("Manual entry");
  });
});

describe("Tracked links", () => {
  it("only redirects to stored destinations, counts clicks atomically per day, and ignores bots and HEAD", async () => {
    const ctx = await setup();
    const ext = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/campaigns/${ctx.campaignId}/links`, { destinationUrl: "https://evil.example.com/x", utm: { source: "tiktok", medium: "social" } });
    expect(ext.status).toBe(422);
    expect(ext.body.error.details.needsConfirmation).toBe(true);
    const created = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/campaigns/${ctx.campaignId}/links`, { destination: "website", slug: "launch-week", utm: { source: "tiktok", medium: "social", content: "hook-a" }, channel: "tiktok" });
    expect(created.status).toBe(201);
    const link = created.body.link;
    expect(link.redirectUrl).toBe("https://focusly.app/?utm_source=tiktok&utm_medium=social&utm_campaign=launch-week&utm_content=hook-a");
    expect(created.body.publicUrl).toMatch(/\/r\/launch-week$/);
    expect((await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/campaigns/${ctx.campaignId}/links`, { destination: "website", slug: "launch-week", utm: { source: "x", medium: "y" } })).status).toBe(409);

    const human = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148" };
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => ctx.app.request("/r/launch-week", { headers: { ...human, "x-forwarded-for": `10.0.0.${i}` } })));
    expect(results.every((r) => r.status === 302 && r.headers.get("location") === link.redirectUrl)).toBe(true);
    await ctx.app.request("/r/launch-week", { headers: { "user-agent": "facebookexternalhit/1.1" } });
    await ctx.app.request("/r/launch-week", { method: "HEAD", headers: human });
    expect((await ctx.app.request("/r/nope-nope")).status).toBe(404);
    expect((await ctx.app.request("/r/LAUNCH-WEEK%2F..")).status).toBe(404);

    const links = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/campaigns/${ctx.campaignId}/links`)).body.items;
    expect(links[0]).toMatchObject({ clickCount: 25, uaClassCounts: { mobile: 25, bot: 1 } });
    const obs = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/observations?metric=clicks`)).body.items;
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({ value: 25, attribution: "link", source: "tracked_link", campaignId: ctx.campaignId, provenance: { imported: false } });
    // stored doc has no IP / raw UA
    expect(JSON.stringify(links[0])).not.toMatch(/10\.0\.0|iPhone OS/);

    // campaign-filtered overview: clicks are link-attributed
    const ov = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview?campaignId=${ctx.campaignId}&compare=none`);
    expect(ov.body.metrics.find((m: J) => m.metric === "clicks")).toMatchObject({ value: 25, attribution: "link" });
    expect(ov.body.missing.find((m: J) => m.metric === "revenue").reason).toMatch(/account-wide/);

    // deactivated links stop redirecting; other tenants can't touch them
    expect((await ctx.bob.patch(`/v1/workspaces/${ctx.wsB}/links/${link.id}`, { active: false })).status).toBe(404);
    expect((await ctx.alice.patch(`/v1/workspaces/${ctx.wsA}/links/${link.id}`, { active: false })).status).toBe(200);
    expect((await ctx.app.request("/r/launch-week", { headers: human })).status).toBe(404);
  });

  it("accepts an external destination only with explicit confirmation and Play links get an install referrer", async () => {
    const ctx = await setup();
    const ok = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/campaigns/${ctx.campaignId}/links`, { destinationUrl: "https://blog.example.org/post", confirmExternalDestination: true, utm: { source: "x", medium: "social" } });
    expect(ok.status).toBe(201);
    expect(ok.body.link).toMatchObject({ destinationKind: "other", destinationConfirmedBy: "alice" });
    await ctx.p.db.ws(ctx.wsA).collection("apps").update(ctx.appId, { storeUrls: { ios: "https://apps.apple.com/us/app/focusly/id123456789", android: "https://play.google.com/store/apps/details?id=app.focusly" } }, { actor: "t" });
    const play = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/campaigns/${ctx.campaignId}/links`, { destination: "android", utm: { source: "tiktok", medium: "social" } });
    expect(new URL(play.body.link.redirectUrl).searchParams.get("referrer")).toBe("utm_source=tiktok&utm_medium=social&utm_campaign=launch-week");
    const unsafe = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/campaigns/${ctx.campaignId}/links`, { destinationUrl: "http://169.254.169.254/latest", confirmExternalDestination: true, utm: { source: "x", medium: "y" } });
    expect(unsafe.status).toBe(400);
  });
});

describe("RevenueCat", () => {
  it("validates the key, stores it encrypted, syncs labelled observations and never double counts rolling windows", async () => {
    const ctx = await setup();
    const rc = fakeRevenueCat();
    installRevenueCatFetch(ctx.p, rc.f);
    const bad = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/analytics/revenuecat`, { secretKey: "sk_wrong_key_123", projectId: "proj_test" });
    expect(bad.status).toBe(503);
    expect(bad.body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    expect(bad.body.error.userMessage).toMatch(/Charts & Metrics/);
    expect((await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/analytics/connections`)).body.items).toHaveLength(0);

    const res = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/analytics/revenuecat`, { secretKey: "sk_good_test_key", projectId: "proj_test" });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toContain("sk_good_test_key");
    expect(res.body.account).toMatchObject({ provider: "revenuecat", displayName: "RevenueCat · Focusly", status: "connected", capabilities: ["read_revenue", "read_insights"] });
    await ctx.p.inline!.drain();
    const job = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/jobs/${res.body.job.id}`)).body.job;
    expect(job.status).toBe("succeeded");
    expect(job.output.data.unmapped).toEqual(["some_future_metric (P7D)"]);
    expect(rc.calls.some((c) => c.includes("/charts/revenue?resolution=0"))).toBe(true);

    const ov = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview?from=2026-10-20&to=2026-10-26&compare=none`);
    const revenue = ov.body.metrics.find((m: J) => m.metric === "revenue");
    // 7 complete days from the chart; the incomplete 10/27 point and the trailing-28-day overview total are not added
    expect(revenue).toMatchObject({ value: 421.5, currency: "USD", attribution: "aggregate", imported: false, aggregation: "sum" });
    expect(revenue.sources[0].label).toBe("RevenueCat (API)");
    expect(revenue.definition).toMatch(/RevenueCat Revenue chart/);
    expect(ov.body.metrics.find((m: J) => m.metric === "trials_started").value).toBe(117);
    expect(ov.body.metrics.find((m: J) => m.metric === "new_subscriptions").value).toBe(43);

    const snap = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview?from=2026-10-27&to=2026-10-27&compare=none`);
    expect(snap.body.metrics.find((m: J) => m.metric === "active_subscriptions")).toMatchObject({ value: 268, aggregation: "latest" });
    expect(snap.body.metrics.find((m: J) => m.metric === "mrr")).toMatchObject({ value: 1432.5, currency: "USD" });
    // funnel never invents conversion rates between account-level numbers
    expect(ov.body.funnel.find((s: J) => s.metric === "new_subscriptions").conversionFromPrevious).toBeNull();

    // usage of the third-party calls is metered (cost 0) and visible in the usage summary
    const usage = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/billing/usage/summary?groupBy=provider`);
    expect(usage.body.rows.find((r: J) => r.key === "analytics").calls).toBeGreaterThanOrEqual(6);

    // re-sync upserts instead of duplicating
    await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/analytics/connections/${res.body.account.id}/sync`);
    await ctx.p.inline!.drain();
    const ov2 = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/insights/overview?from=2026-10-20&to=2026-10-26&compare=none`);
    expect(ov2.body.metrics.find((m: J) => m.metric === "revenue").value).toBe(421.5);
  });
});

describe("Experiments and recommendations", () => {
  it("analysis rejects measured claims citing unknown observation ids, and insufficient data skips the model", async () => {
    const ctx = await setup();
    const meta = fakeMeta([]);
    installMetaClient(ctx.p, new MetaClient(ctx.p, { fetch: meta.f, apiKey: "test-key" }));
    const exp = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/experiments`, {
      title: "Hook test",
      hypothesis: "A question hook gets more link clicks",
      variants: [
        { key: "a", label: "Question hook", isControl: true },
        { key: "b", label: "Demo first" },
      ],
      primaryMetric: "clicks",
      status: "running",
    });
    expect(exp.status).toBe(201);
    const expId = exp.body.experiment.id;
    const before = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/billing/credits`)).body.balance.available;
    const empty = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/experiments/${expId}/analyze`);
    await ctx.p.inline!.drain();
    expect(meta.requests).toHaveLength(0);
    const emptyDetail = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/experiments/${expId}`);
    expect(emptyDetail.body.results[0]).toMatchObject({ confidence: "insufficient_data", measured: [] });
    expect((await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/jobs/${empty.body.job.id}`)).body.job.creditsCharged).toBe(0);
    expect((await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/billing/credits`)).body.balance.available).toBe(before);

    const add = (variantKey: string, value: number) =>
      ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/observations`, { metric: "clicks", value, windowStart: "2026-10-20T00:00:00Z", windowEnd: "2026-10-21T00:00:00Z", experimentId: expId, variantKey, attribution: "platform_reported", definition: "TikTok link-in-bio clicks from post insights" });
    const a = (await add("a", 120)).body.observation.id;
    const b = (await add("b", 80)).body.observation.id;
    meta.requests.length = 0;
    const analysis = {
      summary: "Variant A received more clicks than B in the same window.",
      measured: [
        { text: "Variant A had 120 clicks and B had 80.", observationIds: [a, b] },
        { text: "Variant B also drove 900 installs.", observationIds: ["obs_doesnotexist"] },
      ],
      hypotheses: ["The question format may have raised curiosity."],
      limitations: ["One day of data."],
      confidence: "medium",
    };
    const metaClient2 = fakeMeta([JSON.stringify(analysis)]);
    installMetaClient(ctx.p, new MetaClient(ctx.p, { fetch: metaClient2.f, apiKey: "test-key" }));
    await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/experiments/${expId}/analyze`);
    await ctx.p.inline!.drain();
    const detail = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/experiments/${expId}`);
    const result = detail.body.results[0];
    expect(metaClient2.requests[0].model).toBe("muse-spark-1.3");
    expect(result.measured).toEqual([{ text: "Variant A had 120 clicks and B had 80.", observationIds: [a, b] }]);
    expect(result.validation.droppedMeasured).toBe(1);
    expect(result.validation.notes.join(" ")).toMatch(/obs_doesnotexist/);
    expect(result.perVariant.find((v: J) => v.key === "a").metrics[0]).toMatchObject({ metric: "clicks", value: 120 });
    expect(result.limitations.join(" ")).toMatch(/imported or entered manually/);
    expect(result.model).toBe("muse-spark-1.3");
    expect(detail.body.experiment.lastResultId).toBe(result.id);
    // other tenants can't read it
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsB}/experiments/${expId}`)).status).toBe(404);
  });

  it("recommendations: Spark interprets, Wonder proposes, memory ids are validated, accept creates an experiment and records a decision", async () => {
    const ctx = await setup();
    const ws = ctx.p.db.ws(ctx.wsA);
    const pref = await ws.collection("brandPreferences").create({ appId: ctx.appId, kind: "lesson", text: "Founder-on-camera videos outperform screen recordings for us", source: { type: "explicit" }, weight: 0.8, tags: [], active: true }, { actor: "alice" });
    installMemoryApi(fallbackMemoryApi); // deterministic: module B has its own tests for the Glimmer-backed API
    const interpretation = { insights: [{ text: "No measured performance data yet.", basis: "measured", observationIds: ["obs_unknown"], resultIds: [] }], dataGaps: ["No installs data"] };
    const proposal = {
      recommendations: [
        {
          title: "Test founder-on-camera vs screen recording hooks",
          rationale: "Memory says founder videos worked before; measure it with tracked links.",
          kind: "next_experiment",
          observationIds: [],
          resultIds: [],
          preferenceIds: [pref.id, "prf_made_up"],
          proposedExperiment: { title: "Founder vs screen hook", hypothesis: "Founder-on-camera hooks get more link clicks", primaryMetric: "clicks", variants: ["Founder on camera", "Screen recording"] },
          confidence: "high",
        },
      ],
    };
    const meta = fakeMeta([JSON.stringify(interpretation), JSON.stringify(proposal)]);
    installMetaClient(ctx.p, new MetaClient(ctx.p, { fetch: meta.f, apiKey: "test-key" }));
    const gen = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/recommendations/generate`);
    expect(gen.status).toBe(202);
    await ctx.p.inline!.drain();
    const job = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/jobs/${gen.body.job.id}`)).body.job;
    expect(job.status).toBe("succeeded");
    expect(meta.requests.map((r) => r.model)).toEqual(["muse-spark-1.3", "muse-wonder-1.0"]);
    expect(meta.requests[1].input[0].content[0].text).toContain(pref.id);
    const recs = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/apps/${ctx.appId}/recommendations`)).body.items;
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ usedMemory: true, confidence: "low", basedOn: { preferenceIds: [pref.id] }, models: { interpret: "muse-spark-1.3", propose: "muse-wonder-1.0" } });
    expect(recs[0].rationale).toMatch(/limited measured data/);

    const accepted = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/recommendations/${recs[0].id}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.experiment).toMatchObject({ status: "proposed", primaryMetric: "clicks", proposedByRecommendationId: recs[0].id });
    expect(accepted.body.experiment.variants.map((v: J) => v.label)).toEqual(["Founder on camera", "Screen recording"]);
    const prefs = (await ws.collection("brandPreferences").list({ where: [["appId", "==", ctx.appId], ["active", "==", true]], orderBy: { field: "createdAt", dir: "desc" }, limit: 10 })).items;
    expect(prefs.some((x) => x.kind === "decision" && x.text.includes("Founder vs screen") === false && x.text.startsWith("Accepted recommendation"))).toBe(true);

    // concluding the experiment records a lesson
    const expId = accepted.body.experiment.id;
    await ctx.alice.patch(`/v1/workspaces/${ctx.wsA}/experiments/${expId}`, { status: "running" });
    expect((await ctx.alice.patch(`/v1/workspaces/${ctx.wsA}/experiments/${expId}`, { status: "concluded" })).status).toBe(400);
    await ctx.alice.patch(`/v1/workspaces/${ctx.wsA}/experiments/${expId}`, { status: "concluded", decision: "Keep founder-on-camera hooks for launch posts" });
    const lessons = (await ws.collection("brandPreferences").list({ where: [["appId", "==", ctx.appId], ["active", "==", true]], orderBy: { field: "createdAt", dir: "desc" }, limit: 10 })).items;
    expect(lessons.some((x) => x.kind === "lesson" && x.text.includes("Keep founder-on-camera hooks"))).toBe(true);
  });
});

describe("Billing, quotas and ops", () => {
  it("enforces plan quotas with a friendly message and gives daily slots back when work fails", async () => {
    let fail = false;
    const ctx = await setup({
      "research.run": async () => {
        if (fail) throw new AppError("PROVIDER_ERROR", "boom", { retryable: false });
        return {};
      },
    });
    const create = (key: string, defer = false) =>
      ctx.p.jobs.create(ctx.wsA, "research.run", { appId: ctx.appId, researchRunId: "rsr_x", kinds: ["competitors"] }, { actor: "alice", appId: ctx.appId, idempotencyKey: key, deferDispatch: defer });
    // concurrency: free plan allows 2 active jobs
    await create("c1", true);
    await create("c2", true);
    const err = await create("c3", true).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err.code).toBe("QUOTA_EXCEEDED");
    expect(err.toInfo().userMessage).toMatch(/runs up to 2 tasks at once/);
    // chained (child) jobs are not blocked by the concurrency limit, nor are exempt types
    await expect(ctx.p.jobs.create(ctx.wsA, "media.probe", { assetId: "ast_x" }, { actor: "alice", deferDispatch: true })).resolves.toBeTruthy();
    for (const j of (await ctx.p.db.ws(ctx.wsA).collection("jobs").list({ where: [["status", "in", ["queued"]]], limit: 50 })).items) await ctx.p.jobs.requestCancel(ctx.wsA, j.id, "alice");

    // daily research runs: 3 per day on free; c1 and c2 counted, cancelled ones gave slots back
    let q = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/billing/quotas`)).body;
    expect(q.researchRunsPerDay).toEqual({ used: 0, limit: 3 });
    fail = true;
    await create("f1");
    await ctx.p.inline!.drain();
    q = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/billing/quotas`)).body;
    expect(q.researchRunsPerDay.used).toBe(0); // failed run gave its slot back
    fail = false;
    for (const k of ["d1", "d2", "d3"]) {
      await create(k);
      await ctx.p.inline!.drain();
    }
    const over = await create("d4").catch((e) => e);
    expect(over.code).toBe("QUOTA_EXCEEDED");
    expect(over.toInfo().details.quota).toBe("researchRunsPerDay");
    q = (await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/billing/quotas`)).body;
    expect(q.researchRunsPerDay.used).toBe(3);
  });

  it("releases the credit reservation when a job fails", async () => {
    const ctx = await setup({ "research.run": async () => Promise.reject(new AppError("PROVIDER_ERROR", "upstream", { retryable: false })) });
    const before = await ctx.p.credits.balance(ctx.wsA);
    const job = await ctx.p.jobs.create(ctx.wsA, "research.run", { appId: ctx.appId, researchRunId: "rsr_y", kinds: ["competitors"] }, { actor: "alice", appId: ctx.appId, credits: { operation: "research.run" } });
    expect(job.reservation?.credits).toBe(40);
    expect((await ctx.p.credits.balance(ctx.wsA)).available).toBe(before.available - 40);
    await ctx.p.inline!.drain();
    const after = await ctx.p.credits.balance(ctx.wsA);
    expect(after.available).toBe(before.available);
    expect(after.reserved).toBe(0);
    const ledger = await ctx.p.credits.recentLedger(ctx.wsA);
    expect(ledger.some((l) => l.type === "release" && l.jobId === job.id && l.credits === 40)).toBe(true);
    expect((await ctx.p.jobs.get(ctx.wsA, job.id))!.status).toBe("failed");
  });

  it("tops up monthly credits once per period, records upgrade requests honestly, and exposes admin ops only to ADMIN_UIDS", async () => {
    const ctx = await setup();
    // simulate an account created in a previous period with 20 credits left
    const state = ctx.p.db.ws(ctx.wsA).state(BALANCE_KEY, CreditBalance);
    const bal = (await state.get())!;
    await state.set({ ...bal, available: 20, periodStart: "2026-08-01T00:00:00.000Z" });
    const { z } = await import("zod");
    await ctx.p.db.ws(ctx.wsA).state("billing.period", z.object({ periodStart: z.string(), planId: z.string(), granted: z.number(), at: z.string() })).set({ periodStart: "2026-09-01T00:00:00.000Z", planId: "free", granted: 0, at: "2026-09-01T00:00:00.000Z" });
    const plans = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/billing/plans`);
    expect(plans.body.payments).toMatchObject({ enabled: false, provider: "none" });
    expect(plans.body.current.plan.id).toBe("free");
    expect((await state.get())!.available).toBe(300);
    await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/billing/plans`);
    expect((await state.get())!.available).toBe(300);

    const checkout = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/billing/checkout`, { planId: "growth" });
    expect(checkout.status).toBe(503);
    const up = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/billing/upgrade-request`, { planId: "growth", note: "demo" });
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ paymentsEnabled: false, request: { status: "recorded", planId: "growth" } });
    expect(up.body.message).toMatch(/nothing has been charged/);

    expect((await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/admin/ops`)).status).toBe(404);
    process.env.ADMIN_UIDS = "alice";
    const ops = await ctx.alice.get(`/v1/workspaces/${ctx.wsA}/admin/ops`);
    expect(ops.status).toBe(200);
    expect(ops.body.jobs.today.created).toBeGreaterThan(0);
    expect(ops.body.upgradeRequests[0]).toMatchObject({ workspaceId: ctx.wsA, planId: "growth" });
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsB}/admin/ops`)).status).toBe(404);
    const applied = await ctx.alice.post(`/v1/workspaces/${ctx.wsA}/admin/workspaces/${ctx.wsB}/plan`, { planId: "growth" });
    expect(applied.status).toBe(200);
    expect(applied.body.subscription).toMatchObject({ planId: "growth", provider: "manual", status: "active" });
    expect((await ctx.bob.get(`/v1/workspaces/${ctx.wsB}/billing/plans`)).body.current.plan.id).toBe("growth");
    delete process.env.ADMIN_UIDS;
  });
});
