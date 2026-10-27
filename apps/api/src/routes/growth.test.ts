import { configureGrowth, handlers as growthHandlers, runDueScheduledPosts } from "@muselaunch/growth";
import { createTestPlatform, workspaceKey } from "@muselaunch/platform";
import { FakeFetch, growthFixture, installMetaClient, MetaClient } from "@muselaunch/providers";
import { describe, expect, it } from "vitest";
import { buildApp } from "../app";

/**
 * Module E end-to-end through the API + job runner. Provider HTTP is a scripted fetch returning
 * documented response shapes from fixtures/growth (labelled fixtures, not live output).
 */

type J = any;
function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const send = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as J, headers: res.headers };
  };
  return {
    get: (path: string) => send("GET", path),
    post: (path: string, body?: unknown) => send("POST", path, body ?? {}),
    patch: (path: string, body: unknown) => send("PATCH", path, body),
    del: (path: string) => send("DELETE", path),
  };
}

const yt = growthFixture("youtube");
const gm = growthFixture("gmail");
const metaFx = growthFixture("meta-responses");
const VIDEO = Buffer.from("0123456789ABCDEF");

describe("Module E: Discover, publishing, approvals, outreach, OAuth", () => {
  const stubbed: string[] = [];
  const p = createTestPlatform({ META_API_KEY: "test-key", PUBLIC_WEB_URL: "https://app.example.com", API_PUBLIC_URL: "https://api.example.com" }, {
    ...growthHandlers,
    // Other modules' handlers (B, C) are stubbed: this suite only checks that E enqueues them correctly.
    "campaign.generate_concepts": async (ctx) => (stubbed.push(`concepts:${ctx.payload.campaignId}`), {}),
    "research.run": async (ctx) => (stubbed.push(`research:${ctx.payload.researchRunId}`), {}),
  });

  // ---- provider fakes -------------------------------------------------------
  const http = new FakeFetch()
    .on("POST", "https://oauth2.googleapis.com/token", (r) => ({ json: r.form?.code === "gm-code" ? gm.token : yt.token }))
    .on("GET", "https://www.googleapis.com/youtube/v3/channels", { json: yt.channels })
    .on("GET", "https://openidconnect.googleapis.com/v1/userinfo", { json: gm.userinfo })
    .on("POST", "https://www.googleapis.com/upload/youtube/v3/videos", { status: 200, headers: { location: yt.sessionLocation } })
    .on("PUT", yt.sessionLocation, { status: 201, json: yt.video })
    .on("POST", "https://oauth2.googleapis.com/revoke", { status: 200, text: "" })
    .on("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { json: gm.send });
  const creds = { clientId: "google-client", clientSecret: "google-secret" };
  configureGrowth(p, { fetch: http.fetch, sleep: async () => {}, settings: { creds: { youtube: creds, gmail: creds } } });

  let claimId = "clm_placeholder";
  const metaRequests: J[] = [];
  const metaFetch = (async (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body));
    metaRequests.push(req);
    const name = req.text?.format?.name;
    const data =
      name === "TrackerResearch"
        ? {
            found: true,
            displayName: "Example Competitor",
            observations: [
              { kind: "positioning", text: "Positions itself as the planner for busy parents", sourceUrl: "https://www.example-competitor.com/", confidence: 0.8 },
              { kind: "hook", text: "Shorts open with a messy-desk before/after", sourceUrl: "https://www.youtube.com/@examplecompetitor/shorts", confidence: 0.7 },
              { kind: "format", text: "Invented observation with no citation", sourceUrl: "https://uncited.example.com/page", confidence: 0.9 },
            ],
            comparison: [
              { topic: "Offline use", them: "Says it works offline", themSourceUrl: "https://www.example-competitor.com/", usClaimIds: [claimId] },
              { topic: "Price", them: "Free forever", themSourceUrl: "https://www.example-competitor.com/", usClaimIds: ["clm_not_verified"] },
            ],
          }
        : {
            subject: "Your 60-second study setups + a planner idea",
            body: "Hi Sam, your 60-second study setup videos are the clearest I've seen. I build Fixture Planner: it syncs across iPhone and Mac, so a plan made on the laptop is on your phone before class. Would you like to try it for a video? Happy to send access. Thanks, Alex",
            offer: "A free year of Premium",
            claimIdsUsed: [claimId],
            formatReference: "60-second study setup videos",
          };
    const template = name === "TrackerResearch" ? metaFx.trackerResearch : metaFx.outreachPitch;
    const body = JSON.parse(JSON.stringify(template).replace('"__JSON__"', JSON.stringify(JSON.stringify(data))));
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  installMetaClient(p, new MetaClient(p, { fetch: metaFetch, apiKey: "test-key" }));

  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const carol = client(app, "carol", "carol@example.com");
  let wsA = "";
  let wsB = "";
  let A = "";
  let appId = "";
  let campaignId = "";
  let compositionId = "";
  let renderAssetId = "";

  it("sets up workspaces, an editor without publish rights, an app with verified claims and a final render", async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).body.workspace.id;
    A = `/v1/workspaces/${wsA}`;
    const inv = await alice.post(`${A}/invites`, { email: "carol@example.com", role: "editor" });
    expect((await carol.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
    const created = await alice.post(`${A}/apps`, { name: "Fixture Planner" });
    expect(created.status).toBe(201);
    appId = created.body.app.id;
    const ws = p.db.ws(wsA);
    const now = new Date().toISOString();
    claimId = (await ws.collection("claims").create({ appId, text: "Syncs across iPhone and Mac", confidence: 0.9, state: "verified", origin: "user", permittedContexts: ["all"] }, { actor: "alice" })).id;
    campaignId = (await ws.collection("campaigns").create({ appId, name: "Launch week", goal: "launch" }, { actor: "alice" })).id;
    compositionId = (await ws.collection("compositions").create({ appId, campaignId, title: "Reel 1", kind: "video", aspectRatio: "9:16", currentVersion: 1, latestVersion: 1 }, { actor: "alice" })).id;
    const storagePath = workspaceKey(wsA, "renders", "reel1-v1.mp4");
    const put = await p.storage.put(storagePath, VIDEO, { contentType: "video/mp4" });
    renderAssetId = (
      await ws.collection("mediaAssets").create(
        { appId, campaignId, kind: "video", role: "render", origin: "render", storagePath, mimeType: "video/mp4", bytes: VIDEO.length, sha256: put.sha256, status: "ready", render: { compositionId, version: 1, quality: "final" } },
        { actor: "alice" },
      )
    ).id;
    // Research output (normally written by module B's research.run)
    await ws.collection("opportunities").create(
      {
        appId,
        title: "Exam-season planning content",
        topic: "Students share exam timetables",
        audience: "university students",
        whyRelevant: "Matches the planner's sync feature",
        proposedAngle: "Plan on laptop, check on phone",
        confidence: 0.75,
        evidence: [{ kind: "search_result", url: "https://news.example.com/exam-planning", retrievedAt: now }],
        channels: ["tiktok", "youtube"],
        contentType: "short_video",
        effort: "low",
        geography: ["IN"],
        observedAt: now,
        score: 80,
      },
      { actor: "agent:run1" },
    );
    await ws.collection("opportunities").create(
      { appId, title: "Unsourced idea", topic: "x", audience: "x", whyRelevant: "x", proposedAngle: "x", confidence: 0.9, evidence: [{ kind: "model_inference", retrievedAt: now }], contentType: "static", effort: "low", observedAt: now, score: 99 },
      { actor: "agent:run1" },
    );
  });

  // ---------------------------------------------------------------------------
  it("Discover feed: sourced cards only, with sources, retrieval time and confidence", async () => {
    const feed = await alice.get(`${A}/apps/${appId}/discover/feed`);
    expect(feed.status).toBe(200);
    expect(feed.body.items.map((i: J) => i.title)).toEqual(["Exam-season planning content"]);
    expect(feed.body.excluded.unsourced).toBe(1);
    expect(feed.body.items[0]).toMatchObject({ evidenceLabel: "sourced", confidence: 0.75, sources: [expect.objectContaining({ url: "https://news.example.com/exam-planning" })] });
    expect(feed.body.items[0].retrievedAt).toBeTruthy();
    expect((await alice.get(`${A}/apps/${appId}/discover/feed?channel=linkedin`)).body.items).toHaveLength(0);
  });

  it("opportunity actions: save, create campaign (enqueues B's concepts job), investigate (research.run)", async () => {
    const opp = (await alice.get(`${A}/apps/${appId}/discover/feed`)).body.items[0];
    expect((await alice.post(`${A}/apps/${appId}/opportunities/${opp.refId}/save`)).body.opportunity.status).toBe("saved");
    const inv = await alice.post(`${A}/apps/${appId}/opportunities/${opp.refId}/investigate`, { focus: "Which exam boards?" });
    expect(inv.status).toBe(202);
    expect(inv.body.run.inputs.focus).toContain("Which exam boards?");
    const cpg = await alice.post(`${A}/apps/${appId}/opportunities/${opp.refId}/campaign`, {});
    expect(cpg.status).toBe(202);
    expect(cpg.body.campaign).toMatchObject({ opportunityIds: [opp.refId], channels: ["tiktok", "youtube"] });
    expect(cpg.body.job.type).toBe("campaign.generate_concepts");
    await p.inline!.drain();
    expect(stubbed).toEqual(expect.arrayContaining([`concepts:${cpg.body.campaign.id}`, `research:${inv.body.run.id}`]));
    expect((await alice.post(`${A}/apps/${appId}/opportunities/${opp.refId}/campaign`, {})).status).toBe(409);
  });

  let trackerId = "";
  it("trackers: CRUD + discover.refresh keeps only cited observations and verified-claim comparisons", async () => {
    expect((await alice.post(`${A}/apps/${appId}/trackers`, { channel: "youtube", handle: "@examplecompetitor", url: "https://evil.example.com/x", kind: "competitor" })).status).toBe(400);
    const t = await alice.post(`${A}/apps/${appId}/trackers`, { channel: "youtube", handle: "@examplecompetitor", url: "https://www.youtube.com/@examplecompetitor", kind: "competitor" });
    expect(t.status).toBe(201);
    trackerId = t.body.tracker.id;
    const refresh = await alice.post(`${A}/apps/${appId}/trackers/refresh`, {});
    expect(refresh.status).toBe(202);
    expect(refresh.body.job.reservation.credits).toBe(2);
    await p.inline!.drain();
    const job = (await alice.get(`${A}/jobs/${refresh.body.job.id}`)).body.job;
    expect(job.status).toBe("succeeded");
    const req = metaRequests.find((r) => r.text?.format?.name === "TrackerResearch");
    expect(req.tools[0].type).toBe("web_search");
    expect(JSON.stringify(req.input)).toContain("untrusted_content");
    const tracker = (await alice.get(`${A}/trackers/${trackerId}`)).body.tracker;
    expect(tracker.observations.map((o: J) => o.text)).toEqual(["Positions itself as the planner for busy parents", "Shorts open with a messy-desk before/after"]);
    for (const o of tracker.observations) expect(o.source).toMatchObject({ kind: "search_result", url: expect.stringMatching(/^https:\/\//), retrievedAt: expect.any(String) });
    expect(tracker.comparison).toEqual([expect.objectContaining({ topic: "Offline use", us: "Syncs across iPhone and Mac", usClaimIds: [claimId] })]);
    const profile = (await alice.get(`${A}/trackers/${trackerId}/profile`)).body.profile;
    expect(profile.positioning).toHaveLength(1);
    expect(profile.hooks).toHaveLength(1);
    expect(profile.comparison[0].usClaims).toEqual([{ id: claimId, text: "Syncs across iPhone and Mac" }]);
    const stories = (await alice.get(`${A}/apps/${appId}/trackers/stories`)).body.items;
    expect(stories[0]).toMatchObject({ id: trackerId, hasRecent: true, observationCount: 2 });
    const feed = (await alice.get(`${A}/apps/${appId}/discover/feed?types=tracker_update`)).body.items;
    expect(feed).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  let accountId = "";
  it("OAuth: signed state with PKCE; tampered or replayed state rejected; tokens only in secrets", async () => {
    expect((await carol.post(`${A}/connections/youtube/start`, {})).status).toBe(403);
    expect((await alice.post(`${A}/connections/tiktok/start`, {})).status).toBe(503); // not configured → honest
    const start = await alice.post(`${A}/connections/youtube/start`, { appId });
    expect(start.status).toBe(200);
    const url = new URL(start.body.authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api.example.com/v1/oauth/youtube/callback");
    const state = url.searchParams.get("state")!;
    const tampered = state.slice(0, -2) + (state.endsWith("AA") ? "BB" : "AA");
    expect((await app.request(`/v1/oauth/youtube/callback?code=yt-code&state=${encodeURIComponent(tampered)}`)).status).toBe(403);
    expect((await app.request(`/v1/oauth/gmail/callback?code=yt-code&state=${encodeURIComponent(state)}`)).status).toBe(403); // wrong provider
    const ok = await app.request(`/v1/oauth/youtube/callback?code=yt-code&state=${encodeURIComponent(state)}`);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(`https://app.example.com/w/${wsA}/a/${appId}/calendar?connections=1&provider=youtube&status=connected&account=${(await alice.get(`${A}/connections`)).body.items[0].id}`);
    expect((await app.request(`/v1/oauth/youtube/callback?code=yt-code&state=${encodeURIComponent(state)}`)).status).toBe(403); // replay
    const tokenReq = http.calls("POST", "https://oauth2.googleapis.com/token")[0]!;
    expect(tokenReq.form).toMatchObject({ grant_type: "authorization_code", code: "yt-code", redirect_uri: "https://api.example.com/v1/oauth/youtube/callback" });
    expect(tokenReq.form!.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const conns = await alice.get(`${A}/connections`);
    const acc = conns.body.items.find((a: J) => a.provider === "youtube");
    accountId = acc.id;
    expect(acc).toMatchObject({ status: "connected", externalAccountId: "UCFIXTURE0000000000000001", displayName: "Fixture Apps", capabilities: ["publish_video"] });
    expect(JSON.stringify(conns.body)).not.toContain("FIXTURE_ACCESS");
    expect(JSON.stringify(conns.body)).not.toContain("FIXTURE_REFRESH");
    expect(conns.body.providers.find((x: J) => x.provider === "tiktok")).toMatchObject({ configured: false, state: "not_configured" });
    expect(conns.body.providers.find((x: J) => x.provider === "youtube")).toMatchObject({ configured: true, state: "pending_review" });
  });

  let postId = "";
  it("publishing requires an approval of the exact snapshot and the publish capability", async () => {
    const created = await alice.post(`${A}/apps/${appId}/posts`, { campaignId, compositionId, channel: "youtube", accountId, title: "Plan your week in 15 seconds", caption: "Plan on the laptop, check on your phone.", tags: ["productivity"] });
    expect(created.status).toBe(201);
    postId = created.body.post.id;
    expect(created.body.post).toMatchObject({ mode: "api", status: "draft", assetIds: [renderAssetId], compositionVersion: 1 });
    expect(created.body.preflight.errors).toEqual([]);

    const noApproval = await alice.post(`${A}/posts/${postId}/publish`);
    expect(noApproval.status).toBe(409);
    expect(noApproval.body.error.code).toBe("APPROVAL_REQUIRED");

    const req1 = await carol.post(`${A}/posts/${postId}/request-approval`);
    expect(req1.status).toBe(200);
    const approval1 = req1.body.approval;
    expect(approval1).toMatchObject({ status: "pending", action: "publish", subject: { entity: "scheduledPosts", id: postId } });
    expect((await carol.post(`${A}/approvals/${approval1.id}/approve`, { snapshotHash: approval1.snapshotHash })).status).toBe(403);
    const wrong = await alice.post(`${A}/approvals/${approval1.id}/approve`, { snapshotHash: "sha256:not-what-was-shown" });
    expect(wrong.status).toBe(409);

    // Content changes after the request → the old approval is stale and can't be approved.
    const edited = await carol.patch(`${A}/posts/${postId}`, { caption: "Plan on the laptop, check it on your phone." });
    expect(edited.body).toMatchObject({ approvalReset: true, post: { status: "draft" } });
    const stale = await alice.post(`${A}/approvals/${approval1.id}/approve`, { snapshotHash: approval1.snapshotHash });
    expect(stale.status).toBe(409);

    const approval2 = (await carol.post(`${A}/posts/${postId}/request-approval`)).body.approval;
    expect(approval2.snapshotHash).not.toBe(approval1.snapshotHash);
    const ok = await alice.post(`${A}/approvals/${approval2.id}/approve`, { snapshotHash: approval2.snapshotHash });
    expect(ok.status).toBe(200);
    expect(ok.body.post.status).toBe("scheduled");
    expect((await carol.post(`${A}/posts/${postId}/publish`)).status).toBe(403);

    // Approved, then edited → publish refused (stale snapshot).
    await alice.patch(`${A}/posts/${postId}`, { tags: ["productivity", "planner"] });
    const afterEdit = await alice.post(`${A}/posts/${postId}/publish`);
    expect(afterEdit.status).toBe(409);
    expect(afterEdit.body.error.code).toBe("APPROVAL_REQUIRED");
    expect(http.calls("POST", "https://www.googleapis.com/upload/youtube/v3/videos")).toHaveLength(0);
  });

  it("publishes to YouTube with a real remote id/receipt only after approval", async () => {
    const approval = (await alice.post(`${A}/posts/${postId}/request-approval`)).body.approval;
    await alice.post(`${A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash });
    const pub = await alice.post(`${A}/posts/${postId}/publish`);
    expect(pub.status).toBe(202);
    expect(pub.body.job.type).toBe("publish.post");
    await p.inline!.drain();
    const view = (await alice.get(`${A}/posts/${postId}`)).body;
    expect(view.post.status).toBe("published");
    expect(view.publication).toMatchObject({ mode: "api", remoteId: "FIXTUREvid01", remoteUrl: "https://www.youtube.com/watch?v=FIXTUREvid01", receipt: expect.objectContaining({ provider: "youtube", videoId: "FIXTUREvid01", approvalId: approval.id }) });
    expect(view.approval.status).toBe("consumed");
    expect(view.statusLabel).toMatch(/receipt/);
    const init = http.calls("POST", "https://www.googleapis.com/upload/youtube/v3/videos")[0]!;
    expect(init.json).toMatchObject({ snippet: { title: "Plan your week in 15 seconds", tags: ["productivity", "planner"] } });
    expect(http.calls("PUT", yt.sessionLocation)[0]!.bodyBytes).toBe(VIDEO.length);
    expect((await alice.post(`${A}/posts/${postId}/publish`)).status).toBe(409);
    const cal = (await alice.get(`${A}/apps/${appId}/calendar?timezone=Asia/Kolkata`)).body;
    expect(Object.values(cal.days).flat()).toEqual(expect.arrayContaining([expect.objectContaining({ id: postId, status: "published", publication: expect.objectContaining({ mode: "api" }) })]));
  });

  it("the job itself re-checks the snapshot: content changed behind the approval → nothing is uploaded", async () => {
    const post = (await alice.post(`${A}/apps/${appId}/posts`, { campaignId, compositionId, channel: "youtube", accountId, title: "Second", caption: "Second video" })).body.post;
    const approval = (await alice.post(`${A}/posts/${post.id}/request-approval`)).body.approval;
    await alice.post(`${A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash });
    await p.db.ws(wsA).collection("scheduledPosts").update(post.id, { caption: "Changed without re-approval" }, { actor: "mallory" });
    const uploadsBefore = http.calls("POST", "https://www.googleapis.com/upload/youtube/v3/videos").length;
    const job = await p.jobs.create(wsA, "publish.post", { scheduledPostId: post.id, approvalId: approval.id }, { actor: "alice" });
    await p.inline!.drain();
    expect((await p.jobs.get(wsA, job.id))!.error?.code).toBe("APPROVAL_REQUIRED");
    expect((await alice.get(`${A}/posts/${post.id}`)).body.post.status).toBe("failed");
    expect(http.calls("POST", "https://www.googleapis.com/upload/youtube/v3/videos")).toHaveLength(uploadsBefore);
  });

  it("scheduler tick publishes approved posts whose time has come", async () => {
    const post = (await alice.post(`${A}/apps/${appId}/posts`, { campaignId, compositionId, channel: "youtube", accountId, title: "Scheduled", caption: "Scheduled one", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() })).body.post;
    const approval = (await alice.post(`${A}/posts/${post.id}/request-approval`)).body.approval;
    await alice.post(`${A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash });
    expect((await runDueScheduledPosts(p)).enqueued).toBe(0); // not due yet
    await alice.patch(`${A}/posts/${post.id}`, { scheduledAt: new Date(Date.now() - 1000).toISOString() }); // time-only change keeps approval
    const tick = await runDueScheduledPosts(p);
    expect(tick.enqueued).toBe(1);
    await p.inline!.drain();
    expect((await alice.get(`${A}/posts/${post.id}`)).body.post.status).toBe("published");
    expect((await runDueScheduledPosts(p)).enqueued).toBe(0);
  });

  it("manual flow (unconfigured channel): instructions + downloads, never `published`; mark-posted needs a channel URL", async () => {
    const created = await alice.post(`${A}/apps/${appId}/posts`, { campaignId, assetIds: [renderAssetId], channel: "instagram", caption: "Plan on the laptop #productivity" });
    const post = created.body.post;
    expect(post.mode).toBe("manual");
    expect(post.manualInstructions[0]).toMatch(/Why manual: Instagram .* isn't configured/);
    expect((await alice.post(`${A}/posts/${post.id}/mark-posted`, { url: "https://www.instagram.com/reel/ABC/" })).status).toBe(409); // not approved yet
    const approval = (await alice.post(`${A}/posts/${post.id}/request-approval`)).body.approval;
    const decided = await alice.post(`${A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash });
    expect(decided.body.post.status).toBe("manual_post_needed");
    const pub = await alice.post(`${A}/posts/${post.id}/publish`);
    expect(pub.status).toBe(409);
    const manual = (await alice.get(`${A}/posts/${post.id}/manual`)).body;
    expect(manual.instructions.at(-1)).toMatch(/Mark as posted/);
    expect(manual.downloads[0]).toMatchObject({ assetId: renderAssetId, url: expect.stringContaining("/v1/storage/local/") });
    expect((await alice.post(`${A}/posts/${post.id}/mark-posted`, { url: "https://example.com/not-instagram" })).status).toBe(400);
    const marked = await alice.post(`${A}/posts/${post.id}/mark-posted`, { url: "https://www.instagram.com/reel/ABC/" });
    expect(marked.status).toBe(200);
    expect(marked.body.post.status).toBe("manually_posted");
    expect(marked.body.publication).toMatchObject({ mode: "manual_confirmed", remoteUrl: "https://www.instagram.com/reel/ABC/", confirmedBy: "alice" });
    expect(marked.body.publication.remoteId).toBeUndefined();
    const reddit = (await alice.post(`${A}/apps/${appId}/posts`, { campaignId, assetIds: [renderAssetId], channel: "reddit", accountId, caption: "Show-and-tell" })).body.post;
    expect(reddit.mode).toBe("manual");
    expect(reddit.manualInstructions.join(" ")).toMatch(/never posts to Reddit/);
  });

  // ---------------------------------------------------------------------------
  let prospectId = "";
  let draftId = "";
  it("outreach: only sourced public contacts; drafts are claim-checked; AI offers must be confirmed", async () => {
    const now = new Date().toISOString();
    prospectId = (
      await p.db.ws(wsA).collection("outreachProspects").create(
        {
          appId,
          channel: "youtube",
          handle: "samstudies",
          displayName: "Sam",
          niche: "60-second study setup videos",
          relevanceScore: 82,
          relevanceReasons: ["Audience of university students"],
          evidence: [{ kind: "search_result", url: "https://www.youtube.com/@samstudies", retrievedAt: now, excerpt: "60-second study setups every week" }],
          publicContacts: [
            { kind: "email", value: "business@samstudies.com", source: { kind: "search_result", url: "https://www.youtube.com/@samstudies/about", retrievedAt: now, excerpt: "For business inquiries: business@samstudies.com" }, verified: false },
            { kind: "email", value: "sam@samstudies.com", source: { kind: "search_result", url: "https://samstudies.com", retrievedAt: now, excerpt: "Hi, I'm Sam" }, verified: false },
            { kind: "email", value: "sam.studies@gmail.com", source: { kind: "model_inference", retrievedAt: now }, verified: false },
          ],
        },
        { actor: "agent:run1" },
      )
    ).id;
    const prospect = (await alice.get(`${A}/prospects/${prospectId}`)).body.prospect;
    expect(prospect.publicContacts.map((c: J) => c.value)).toEqual(["business@samstudies.com"]);
    expect(prospect.hiddenUnsourcedContacts).toBe(2);

    const job = await alice.post(`${A}/apps/${appId}/prospects/draft`, { prospectIds: [prospectId] });
    expect(job.status).toBe(202);
    await p.inline!.drain();
    const drafts = (await alice.get(`${A}/apps/${appId}/outreach/drafts`)).body.items;
    expect(drafts).toHaveLength(1);
    const d = drafts[0];
    draftId = d.id;
    expect(d).toMatchObject({ prospectId, channel: "email", to: { kind: "email", value: "business@samstudies.com" }, offerSource: "ai_suggested", claimIds: [claimId], status: "draft" });
    expect(d.validation).toMatchObject({ ok: false, validator: "rules", issues: [expect.objectContaining({ id: "offer" })] });
    expect((await p.db.ws(wsA).collection("outreachProspects").get(prospectId))!.status).toBe("drafted");
    const blocked = await alice.post(`${A}/outreach/drafts/${draftId}/request-approval`);
    expect(blocked.status).toBe(422);

    const unverified = await alice.patch(`${A}/outreach/drafts/${draftId}`, { body: `${d.body}\nIt's the #1 planner with 50k users.` });
    expect(unverified.body.draft.validation.ok).toBe(false);
    const fixed = await alice.patch(`${A}/outreach/drafts/${draftId}`, { body: d.body, offer: "A free year of Premium" });
    expect(fixed.body.draft.validation).toMatchObject({ ok: true, issues: [] });
  });

  it("outreach send: approval + capability required; manual copy & mark-sent; anti-blast rate limit; Gmail sends with a receipt", async () => {
    expect((await alice.post(`${A}/outreach/drafts/${draftId}/mark-sent`, {})).body.error.code).toBe("APPROVAL_REQUIRED");
    const { approval } = (await carol.post(`${A}/outreach/drafts/${draftId}/request-approval`)).body;
    expect((await carol.post(`${A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash })).status).toBe(403);
    expect((await alice.post(`${A}/approvals/${approval.id}/approve`, { snapshotHash: approval.snapshotHash })).body.draft.status).toBe("approved");
    expect((await carol.post(`${A}/outreach/drafts/${draftId}/copy`)).status).toBe(403);
    const noGmail = await alice.post(`${A}/outreach/drafts/${draftId}/send`);
    expect(noGmail.status).toBe(503);
    expect(noGmail.body.error.code).toBe("PROVIDER_NOT_CONFIGURED");
    const copy = await alice.post(`${A}/outreach/drafts/${draftId}/copy`);
    expect(copy.body.copy.to.value).toBe("business@samstudies.com");
    const sent = await alice.post(`${A}/outreach/drafts/${draftId}/mark-sent`, {});
    expect(sent.body.draft).toMatchObject({ status: "sent", sendReceipt: { mode: "manual_confirmed", confirmedBy: "alice" } });
    expect((await p.db.ws(wsA).collection("outreachProspects").get(prospectId))!.status).toBe("contacted");
    expect((await p.db.ws(wsA).collection("approvals").get(approval.id))!.status).toBe("consumed");

    // Second draft for the same creator, sent through a connected Gmail account.
    const job = await alice.post(`${A}/apps/${appId}/prospects/draft`, { prospectIds: [prospectId], offer: "A free year of Premium" });
    await p.inline!.drain();
    const second = (await alice.get(`${A}/apps/${appId}/outreach/drafts?prospectId=${prospectId}`)).body.items.find((x: J) => x.status === "draft");
    expect(job.status).toBe(202);
    expect(second.validation.ok).toBe(true);
    const a2 = (await alice.post(`${A}/outreach/drafts/${second.id}/request-approval`)).body.approval;
    await alice.post(`${A}/approvals/${a2.id}/approve`, { snapshotHash: a2.snapshotHash });
    const start = await alice.post(`${A}/connections/gmail/start`, {});
    const st = new URL(start.body.authorizeUrl).searchParams.get("state")!;
    expect((await app.request(`/v1/oauth/gmail/callback?code=gm-code&state=${encodeURIComponent(st)}`)).status).toBe(302);
    const tooSoon = await alice.post(`${A}/outreach/drafts/${second.id}/send`);
    expect(tooSoon.status).toBe(429); // minimum gap between sends
    configureGrowth(p, { settings: { outreachMinIntervalSec: 0.001 } });
    const go = await alice.post(`${A}/outreach/drafts/${second.id}/send`);
    expect(go.status).toBe(202);
    await p.inline!.drain();
    const done = (await alice.get(`${A}/outreach/drafts/${second.id}`)).body.draft;
    expect(done).toMatchObject({ status: "sent", sendReceipt: { provider: "gmail", messageId: gm.send.id } });
    const raw = Buffer.from((http.calls("POST", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send")[0]!.json as J).raw, "base64url").toString("utf8");
    expect(raw).toContain("To: business@samstudies.com");
    expect(raw).toContain("From: founder@fixture.example");
  });

  it("disconnect revokes at the provider and deletes the stored tokens", async () => {
    const out = await alice.del(`${A}/connections/${accountId}`);
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ revokedRemotely: true, account: { status: "revoked" } });
    expect(out.body.account.secretId).toBeUndefined();
    expect(http.calls("POST", "https://oauth2.googleapis.com/revoke")[0]!.form).toEqual({ token: "1//FIXTURE_REFRESH" });
  });

  it("tenancy: another workspace can't read or act on any of it", async () => {
    const B = `/v1/workspaces/${wsB}`;
    expect((await bob.get(`${A}/apps/${appId}/discover/feed`)).status).toBe(404);
    expect((await bob.get(`${B}/posts/${postId}`)).status).toBe(404);
    expect((await bob.get(`${B}/trackers/${trackerId}`)).status).toBe(404);
    expect((await bob.get(`${B}/prospects/${prospectId}`)).status).toBe(404);
    expect((await bob.get(`${B}/outreach/drafts/${draftId}`)).status).toBe(404);
    const anyApproval = (await alice.get(`${A}/approvals`)).body.items[0];
    expect((await bob.post(`${B}/approvals/${anyApproval.id}/approve`, { snapshotHash: anyApproval.snapshotHash })).status).toBe(404);
    expect((await bob.post(`${B}/apps/${appId}/trackers/refresh`, {})).status).toBe(404);
    expect((await bob.get(`${B}/connections`)).body.items).toEqual([]);
  });
});
