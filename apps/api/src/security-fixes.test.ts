import { planSnapshot } from "@muselaunch/agents";
import { installAnalyticsHooks } from "@muselaunch/analytics";
import { createComposition } from "@muselaunch/compositions/store";
import { AgentBudget } from "@muselaunch/contracts";
import { configureGrowth, handlers as growthHandlers, SEALED_STATE_VALUE } from "@muselaunch/growth";
import { createTestPlatform, LocalStorage, workspaceKey, type HandlerRegistry } from "@muselaunch/platform";
import { FakeFetch, growthFixture } from "@muselaunch/providers";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { logPath } from "./middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

/** Regression tests for the security review fixes (one block per finding). */

function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: method === "GET" ? undefined : JSON.stringify(body ?? {}) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as J, text, headers: res.headers };
  };
  return { get: (p: string) => send("GET", p), post: (p: string, b?: unknown) => send("POST", p, b), patch: (p: string, b: unknown) => send("PATCH", p, b), del: (p: string) => send("DELETE", p) };
}

async function workspaceWithEditor(handlers: HandlerRegistry = {}, overrides: Record<string, string> = {}) {
  const p = createTestPlatform({ PUBLIC_WEB_URL: "https://app.example.com", API_PUBLIC_URL: "https://api.example.com", ...overrides }, handlers);
  const app = buildApp(p);
  const alice = client(app, "alice");
  const eddie = client(app, "eddie");
  const bob = client(app, "bob");
  const wsA = (await alice.post("/v1/workspaces", { name: "Alice" })).body.workspace.id as string;
  const wsB = (await bob.post("/v1/workspaces", { name: "Bob" })).body.workspace.id as string;
  const A = `/v1/workspaces/${wsA}`;
  const inv = await alice.post(`${A}/invites`, { email: "eddie@example.com", role: "editor" });
  expect((await eddie.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
  const appId = (await alice.post(`${A}/apps`, { name: "Focusly" })).body.app.id as string;
  return { p, app, alice, eddie, bob, wsA, wsB, A, appId };
}

describe("F1: strategist spend approvals need the spend approver capability (billing.manage)", () => {
  it("an editor can neither approve nor reject; the owner can", async () => {
    const s = await workspaceWithEditor({ "research.run": async () => ({ creditsUsed: 0 }) });
    const ws = s.p.db.ws(s.wsA);
    const plan = {
      goal: "Grow installs",
      tasks: [{ id: "task_p1", role: "research" as const, title: "Research: trends", objective: "o", status: "pending" as const, proposedAction: { type: "research.run" as const, params: { kinds: ["trends"], focus: "f" }, estimatedCredits: 40 } }],
    };
    const run = await ws.collection("agentRuns").create({ appId: s.appId, kind: "growth_strategy", model: "muse-wonder-1.0", status: "needs_approval", goal: "Grow installs", budget: AgentBudget.parse({}), plan }, { actor: "job:x" });
    const approval = await ws.collection("approvals").create(
      { appId: s.appId, action: "spend", subject: { entity: "agentRuns", id: run.id }, snapshotHash: planSnapshot(run.plan!), summary: "Research (≈40 credits)", requestedBy: `agent:${run.id}`, status: "pending", estimate: { credits: 40 } },
      { actor: "job:x" },
    );
    await ws.collection("agentRuns").update(run.id, { pendingApprovalId: approval.id }, { actor: "job:x" });

    expect((await s.eddie.post(`${s.A}/agent-runs/${run.id}/approve`)).status).toBe(403);
    expect((await s.eddie.post(`${s.A}/agent-runs/${run.id}/reject`)).status).toBe(403);
    expect((await ws.collection("approvals").get(approval.id))!.status).toBe("pending");
    expect((await ws.collection("jobs").list({ limit: 50 })).items.filter((j) => j.type === "research.run")).toHaveLength(0);
    // Same rule as the generic approval endpoint, which already required billing.manage for "spend".
    expect((await s.eddie.post(`${s.A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash })).status).toBe(403);

    const ok = await s.alice.post(`${s.A}/agent-runs/${run.id}/approve`);
    expect(ok.status).toBe(202);
    expect(ok.body.jobs.map((j: J) => j.type)).toEqual(["research.run"]);
  });
});

describe("F2: generic job retry can't re-run external actions", () => {
  it("publish.post and outreach.send retries are refused (even for the owner); other jobs still retry with a new reservation", async () => {
    const s = await workspaceWithEditor();
    const ws = s.p.db.ws(s.wsA);
    const campaign = await ws.collection("campaigns").create({ appId: s.appId, name: "Launch", goal: "launch" }, { actor: "alice" });
    const failed = async (type: "publish.post" | "outreach.send" | "copy.generate", payload: Record<string, unknown>, credits?: { operation: string }) => {
      const job = await s.p.jobs.create(s.wsA, type, payload as never, { actor: "alice", deferDispatch: true, credits });
      await ws.collection("jobs").update(job.id, { status: "failed" }, { actor: "test" });
      return job;
    };
    const publish = await failed("publish.post", { scheduledPostId: "pst_x", approvalId: "apr_x" });
    const send = await failed("outreach.send", { draftId: "odr_x", approvalId: "apr_y" });
    for (const who of [s.eddie, s.alice]) {
      for (const job of [publish, send]) {
        const res = await who.post(`${s.A}/jobs/${job.id}/retry`);
        expect(res.status).toBe(409);
        expect(res.body.error.userMessage).toMatch(/again from/);
      }
    }
    expect((await ws.collection("jobs").list({ limit: 50 })).items.filter((j) => j.parentJobId)).toHaveLength(0);

    const copy = await failed("copy.generate", { appId: s.appId, campaignId: campaign.id, channels: ["instagram"] }, { operation: "copy.generate" });
    const retried = await s.eddie.post(`${s.A}/jobs/${copy.id}/retry`);
    expect(retried.status).toBe(202);
    expect(retried.body.job).toMatchObject({ type: "copy.generate", parentJobId: copy.id, reservation: { credits: copy.reservation!.credits } });
  });
});

describe("F4: a retry is new work for the plan's concurrency quota", () => {
  it("cancel → retry can't exceed the concurrent-job limit", async () => {
    const s = await workspaceWithEditor();
    installAnalyticsHooks(s.p);
    const ws = s.p.db.ws(s.wsA);
    const campaign = await ws.collection("campaigns").create({ appId: s.appId, name: "Launch", goal: "launch" }, { actor: "alice" });
    const payload = { appId: s.appId, campaignId: campaign.id, channels: ["instagram"] };
    const opts = { actor: "alice", deferDispatch: true, credits: { operation: "copy.generate" } };
    const parked = await s.p.jobs.create(s.wsA, "copy.generate", payload, opts);
    await s.p.jobs.requestCancel(s.wsA, parked.id, "alice");
    // Free plan: 2 concurrent jobs.
    await s.p.jobs.create(s.wsA, "copy.generate", payload, opts);
    await s.p.jobs.create(s.wsA, "copy.generate", payload, opts);
    await expect(s.p.jobs.create(s.wsA, "copy.generate", payload, opts)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    const retry = await s.alice.post(`${s.A}/jobs/${parked.id}/retry`);
    expect(retry.status).toBe(429);
    expect(retry.body.error.code).toBe("QUOTA_EXCEEDED");
  });
});

describe("F6/F7/F8: URL policy on app edits, signed storage URLs and uploads", () => {
  it("PATCH /apps refuses internal store URLs like POST does", async () => {
    const s = await workspaceWithEditor();
    for (const storeUrls of [{ ios: "http://169.254.169.254/latest/meta-data" }, { android: "http://[::7f00:1]/" }, { ios: "http://localhost/x" }]) {
      const res = await s.alice.patch(`${s.A}/apps/${s.appId}`, { storeUrls });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("UNSAFE_URL");
    }
    expect((await s.alice.patch(`${s.A}/apps/${s.appId}`, { storeUrls: { ios: "https://apps.apple.com/us/app/focusly/id123456789" } })).status).toBe(200);
  });

  it("never signs or deletes an object outside the caller's workspace, even if an asset row points there", async () => {
    const s = await workspaceWithEditor();
    const bobKey = workspaceKey(s.wsB, "uploads", "ast_bob", "private.png");
    await s.p.storage.put(bobKey, Buffer.from("BOB-PRIVATE"), { contentType: "image/png" });
    const planted = await s.p.db
      .ws(s.wsA)
      .collection("mediaAssets")
      .create({ appId: s.appId, kind: "image", role: "screenshot", origin: "upload", storagePath: bobKey, mimeType: "image/png", bytes: 11, status: "ready", isProductTruth: true }, { actor: "alice" });
    const url = await s.alice.get(`${s.A}/assets/${planted.id}/url`);
    expect(url.status).toBe(403);
    expect(url.text).not.toContain("/v1/storage/local/");
    expect((await s.alice.del(`${s.A}/assets/${planted.id}`)).status).toBe(403);
    expect(await s.p.storage.stat(bobKey)).not.toBeNull();
  });

  it("a signed upload URL is single-use: it can't replace a file after it was probed and approved", async () => {
    const s = await workspaceWithEditor({ "media.probe": async () => ({}) });
    const ws = s.p.db.ws(s.wsA);
    const up = await s.eddie.post(`${s.A}/uploads`, { filename: "shot.png", mimeType: "image/png", bytes: 8, role: "screenshot", appId: s.appId });
    const putPath = new URL(up.body.upload.url).pathname;
    expect((await s.app.request(putPath, { method: "PUT", headers: { "content-type": "image/png" }, body: "APPROVED" })).status).toBe(200);
    expect((await s.eddie.post(`${s.A}/assets/${up.body.asset.id}/complete`)).status).toBe(200);
    const campaign = await ws.collection("campaigns").create({ appId: s.appId, name: "Launch", goal: "launch" }, { actor: "alice" });
    const post = (await s.eddie.post(`${s.A}/apps/${s.appId}/posts`, { campaignId: campaign.id, assetIds: [up.body.asset.id], channel: "reddit", caption: "Look" })).body.post;
    const approval = (await s.eddie.post(`${s.A}/posts/${post.id}/request-approval`)).body.approval;
    expect((await s.alice.post(`${s.A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash })).status).toBe(200);
    // The uploader replays the (still unexpired) URL with different bytes.
    const replay = await s.app.request(putPath, { method: "PUT", headers: { "content-type": "image/png" }, body: "SWAPPED!" });
    expect(replay.status).toBe(409);
    const asset = (await ws.collection("mediaAssets").get(up.body.asset.id))!;
    expect((await s.p.storage.get(asset.storagePath)).toString()).toBe("APPROVED");
  });

  it("uploads enforce type, size and method-bound, unforgeable, expiring tokens; downloads are sandboxed", async () => {
    const s = await workspaceWithEditor();
    expect((await s.alice.post(`${s.A}/uploads`, { filename: "x.html", mimeType: "text/html", bytes: 10, role: "screenshot" })).status).toBe(400);
    expect((await s.alice.post(`${s.A}/uploads`, { filename: "x.png", mimeType: "image/png", bytes: 30 * 1024 * 1024, role: "screenshot" })).status).toBe(400);
    const up = await s.alice.post(`${s.A}/uploads`, { filename: "logo.svg", mimeType: "image/svg+xml", bytes: 64, role: "logo", appId: s.appId });
    expect(up.status).toBe(201);
    const putPath = new URL(up.body.upload.url).pathname;
    // Wrong content type, then a body larger than declared.
    expect((await s.app.request(putPath, { method: "PUT", headers: { "content-type": "text/html" }, body: "<svg/>" })).status).toBe(400);
    expect((await s.app.request(putPath, { method: "PUT", headers: { "content-type": "image/svg+xml" }, body: "x".repeat(500) })).status).toBe(400);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`.slice(0, 64);
    expect((await s.app.request(putPath, { method: "PUT", headers: { "content-type": "image/svg+xml" }, body: svg })).status).toBe(200);
    // An upload token can't be used to read.
    expect((await s.app.request(putPath)).status).toBe(403);
    expect((await s.alice.post(`${s.A}/assets/${up.body.asset.id}/complete`)).status).toBe(200);
    const { url } = (await s.alice.get(`${s.A}/assets/${up.body.asset.id}/url`)).body;
    const getPath = new URL(url).pathname;
    const res = await s.app.request(getPath);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(res.headers.get("content-security-policy")).toMatch(/default-src 'none'/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // A download token can't be used to overwrite.
    expect((await s.app.request(getPath, { method: "PUT", headers: { "content-type": "image/svg+xml" }, body: "<svg/>" })).status).toBe(403);
    // Re-targeting a token at another workspace's key breaks its signature.
    const token = getPath.split("/").pop()!;
    const [payload, mac] = token.split(".");
    const forged = { ...JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")), k: workspaceKey(s.wsB, "uploads", "x", "y.png") };
    expect((await s.app.request(`/v1/storage/local/${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${mac}`)).status).toBe(403);
    // Expired tokens are refused.
    const storage = s.p.storage as LocalStorage;
    const expired = await storage.signedDownloadUrl(workspaceKey(s.wsA, "uploads", up.body.asset.id, "logo.svg"), { expiresSec: -5 });
    expect((await s.app.request(new URL(expired.url).pathname)).status).toBe(403);
    // Access logs never carry the bearer token.
    expect(logPath(getPath)).toBe("/v1/storage/local/[token]");
    expect(logPath(`/v1/workspaces/ws_1/assets`)).toBe("/v1/workspaces/ws_1/assets");
  });
});

describe("F3 + OAuth: publish resume state and connection callbacks", () => {
  const yt = growthFixture("youtube");
  const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&upload_id=SECRET_SESSION_ID";
  const http = new FakeFetch()
    .on("POST", "https://oauth2.googleapis.com/token", { json: yt.token })
    .on("GET", "https://www.googleapis.com/youtube/v3/channels", { json: yt.channels })
    .on("POST", "https://www.googleapis.com/upload/youtube/v3/videos", { status: 200, headers: { location: SESSION } })
    // 1st: upload interrupted (308 incomplete). 2nd: the resume probe finds the finished upload.
    .on("PUT", SESSION, { status: 308, text: "" }, { status: 201, json: yt.video });
  const creds = { clientId: "google-client", clientSecret: "google-secret" };

  async function setup() {
    const s = await workspaceWithEditor({ ...growthHandlers });
    configureGrowth(s.p, { fetch: http.fetch, sleep: async () => {}, claimValidator: null, settings: { creds: { youtube: creds } } });
    return s;
  }

  it("upload-session URLs (bearer capabilities) are sealed in secrets, never returned by the API, and still resume", async () => {
    const s = await setup();
    const ws = s.p.db.ws(s.wsA);
    const campaign = await ws.collection("campaigns").create({ appId: s.appId, name: "Launch", goal: "launch" }, { actor: "alice" });
    const key = workspaceKey(s.wsA, "renders", "reel.mp4");
    const put = await s.p.storage.put(key, Buffer.from("0123456789ABCDEF"), { contentType: "video/mp4" });
    const video = await ws.collection("mediaAssets").create({ appId: s.appId, campaignId: campaign.id, kind: "video", role: "render", origin: "render", storagePath: key, mimeType: "video/mp4", bytes: 16, sha256: put.sha256, status: "ready" }, { actor: "alice" });
    await s.p.secrets.put(s.wsA, "tok_acc_yt", "oauth_youtube", { accessToken: "ya29.TEST", refreshToken: "1//TEST", scope: [] });
    await ws.collection("connectedAccounts").create(
      { id: "acc_yt", appId: s.appId, provider: "youtube", purposes: ["publishing"], externalAccountId: "UC1", displayName: "Channel", status: "connected", capabilities: ["publish_video"], secretId: "tok_acc_yt", connectedBy: "alice" },
      { actor: "alice" },
    );
    const post = (await s.alice.post(`${s.A}/apps/${s.appId}/posts`, { campaignId: campaign.id, assetIds: [video.id], channel: "youtube", accountId: "acc_yt", title: "Title", caption: "Caption" })).body.post;
    expect(post.mode).toBe("api");
    const approval = (await s.alice.post(`${s.A}/posts/${post.id}/request-approval`)).body.approval;
    expect((await s.alice.post(`${s.A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash })).status).toBe(200);

    // First attempt starts a resumable session and is interrupted.
    const job = await s.p.jobs.create(s.wsA, "publish.post", { scheduledPostId: post.id, approvalId: approval.id }, { actor: "alice", maxAttempts: 1 });
    await s.p.inline!.drain();
    expect((await s.p.jobs.get(s.wsA, job.id))!.status).toBe("failed");
    const stored = await ws.collection("scheduledPosts").get(post.id);
    expect(stored!.publishState).toMatchObject({ youtubeSessionUrl: SEALED_STATE_VALUE });
    expect(JSON.stringify(stored)).not.toContain("SECRET_SESSION_ID");
    for (const path of [`${s.A}/posts/${post.id}`, `${s.A}/apps/${s.appId}/posts`, `${s.A}/apps/${s.appId}/calendar`]) {
      const res = await s.eddie.get(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain("SECRET_SESSION_ID");
    }

    // Publishing again resumes the same session (no second videos.insert) and completes.
    expect((await s.alice.post(`${s.A}/posts/${post.id}/publish`)).status).toBe(202);
    await s.p.inline!.drain();
    const view = (await s.alice.get(`${s.A}/posts/${post.id}`)).body;
    expect(view.post.status).toBe("published");
    expect(http.calls("POST", "https://www.googleapis.com/upload/youtube/v3/videos")).toHaveLength(1);
    expect(http.calls("PUT", SESSION)).toHaveLength(2);
    expect(http.calls("PUT", SESSION)[1]!.headers["content-range"]).toBe("bytes */16");
  });

  it("an OAuth callback is refused once the user who started it lost accounts.manage; redirects stay on the web app", async () => {
    const s = await setup();
    expect((await s.alice.patch(`${s.A}/members/eddie`, { canManageAccounts: true })).status).toBe(200);
    const start = await s.eddie.post(`${s.A}/connections/youtube/start`, {});
    expect(start.status).toBe(200);
    const state = new URL(start.body.authorizeUrl).searchParams.get("state")!;
    expect((await s.alice.del(`${s.A}/members/eddie`)).status).toBe(200);
    const tokenCalls = http.calls("POST", "https://oauth2.googleapis.com/token").length;
    const res = await s.app.request(`/v1/oauth/youtube/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(403);
    expect(http.calls("POST", "https://oauth2.googleapis.com/token")).toHaveLength(tokenCalls);
    expect((await s.p.db.ws(s.wsA).collection("connectedAccounts").list({ limit: 10 })).items).toHaveLength(0);

    const own = new URL((await s.alice.post(`${s.A}/connections/youtube/start`, {})).body.authorizeUrl).searchParams.get("state")!;
    const denied = await s.app.request(`/v1/oauth/youtube/callback?error=access_denied&error_description=${encodeURIComponent("https://evil.example.com")}&state=${encodeURIComponent(own)}`);
    expect(denied.status).toBe(302);
    expect(denied.headers.get("location")!.startsWith(`https://app.example.com/w/${s.wsA}/`)).toBe(true);
    // Unknown provider / missing state never redirect anywhere.
    expect((await s.app.request(`/v1/oauth/evil/callback?code=c&state=${encodeURIComponent(own)}`)).status).toBe(404);
    expect((await s.app.request(`/v1/oauth/youtube/callback?code=c`)).status).toBe(403);
  });
});

describe("F9/F10: invites can't exceed the plan's seats or demote an existing member", () => {
  it("outstanding invites can't all be accepted past the member limit", async () => {
    const p = createTestPlatform();
    const app = buildApp(p);
    const alice = client(app, "alice");
    const wsA = (await alice.post("/v1/workspaces", { name: "Alice" })).body.workspace.id as string;
    // Free plan: 2 members. Both invites are allowed while only the owner is active...
    const tokens: string[] = [];
    for (const who of ["carol", "dave"]) tokens.push((await alice.post(`/v1/workspaces/${wsA}/invites`, { email: `${who}@example.com`, role: "editor" })).body.acceptUrl.split("/").pop());
    expect((await client(app, "carol").post(`/v1/invites/${tokens[0]}/accept`)).status).toBe(200);
    // ...but only one seat was free.
    const over = await client(app, "dave").post(`/v1/invites/${tokens[1]}/accept`);
    expect(over.status).toBe(429);
    expect(over.body.error.code).toBe("QUOTA_EXCEEDED");
    expect((await client(app, "dave").get(`/v1/workspaces/${wsA}`)).status).toBe(404);
  });

  it("an admin can't demote the owner by getting them to click an invite", async () => {
    const s = await workspaceWithEditor();
    await s.p.db.top("workspaces").update(s.wsA, { planId: "studio" });
    expect((await s.alice.patch(`${s.A}/members/eddie`, { role: "admin" })).status).toBe(200);
    const inv = await s.eddie.post(`${s.A}/invites`, { email: "alice@example.com", role: "viewer" });
    expect(inv.status).toBe(201);
    const accepted = await s.alice.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.member.role).toBe("owner");
    expect((await s.eddie.del(`${s.A}/members/alice`)).status).toBe(403);
    expect((await s.alice.get(s.A)).body.member).toMatchObject({ role: "owner", canPublish: true, canManageAccounts: true });
  });
});

describe("phase 2: object ids in compositions can't carry markup or script", () => {
  it("rejects an effect layer / anchor whose SAM object id would break out of the compiled HTML", async () => {
    const s = await workspaceWithEditor();
    const doc = {
      schemaVersion: 1,
      title: "Reel",
      kind: "video",
      aspectRatio: "9:16",
      width: 1080,
      height: 1920,
      fps: 30,
      theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#0A84FF" },
      scenes: [{ id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 3, layers: [{ id: "ly_hook", type: "text", role: "headline", text: "Hi", box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 } }] }],
    };
    const { composition } = await createComposition(s.p.db.ws(s.wsA), { appId: s.appId, title: "Reel", doc: doc as never }, "alice");
    const effect = (objectId: string) => ({ op: "add_layer", sceneId: "sc_hook", layer: { id: "ly_fx", type: "effect", effect: "highlight-ring", target: { segmentationId: "seg_1", objectId }, box: { x: 0, y: 0, w: 1, h: 1 } } });
    const anchored = (objectId: string) => ({ op: "update_layer", sceneId: "sc_hook", layerId: "ly_hook", set: { anchor: { segmentationId: "seg_1", objectId } } });
    for (const bad of [`1");fetch("//evil.example");//`, "</script><script>alert(1)</script>", "a'b", "a\\b"]) {
      for (const op of [effect(bad), anchored(bad)]) {
        const res = await s.alice.post(`${s.A}/compositions/${composition.id}/patch`, { baseVersion: 1, ops: [op] });
        expect(res.status, JSON.stringify(op)).toBeGreaterThanOrEqual(400);
        expect(res.status).toBeLessThan(500);
      }
    }
    const ok = await s.alice.post(`${s.A}/compositions/${composition.id}/patch`, { baseVersion: 1, ops: [effect("1")] });
    expect(ok.status).toBe(200);
  });
});

describe("tracked-link redirects only go to the stored destination", () => {
  it("ignores query/path tricks on /r/:slug", async () => {
    const s = await workspaceWithEditor();
    await s.alice.patch(`${s.A}/apps/${s.appId}`, { websiteUrl: "https://focusly.app" });
    const campaign = await s.p.db.ws(s.wsA).collection("campaigns").create({ appId: s.appId, name: "Launch", goal: "launch" }, { actor: "alice" });
    const link = (await s.alice.post(`${s.A}/campaigns/${campaign.id}/links`, { destination: "website", slug: "launch-week", utm: { source: "tiktok", medium: "social" } })).body.link;
    for (const path of ["/r/launch-week?url=https://evil.example.com", "/r/launch-week?redirect=//evil.example.com"]) {
      const res = await s.app.request(path);
      // Website destinations are served via a "Continue to <host>" page (never a silent 302); only store pages redirect.
      expect(res.status).toBe(200);
      expect(res.headers.get("location")).toBeNull();
      const href = /<a class="c" href="([^"]+)"/.exec(await res.text())![1]!.replace(/&amp;/g, "&");
      expect(new URL(href).hostname).toBe("focusly.app");
    }
    expect((await s.app.request("/r/launch-week%2F%2Fevil.example.com")).status).toBe(404);
    expect((await s.app.request("/r/..%2Fv1%2Fme")).status).toBe(404);
    await s.alice.patch(`${s.A}/links/${link.id}`, { active: false });
    expect((await s.app.request("/r/launch-week")).status).toBe(404);
  });
});
