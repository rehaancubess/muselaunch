import { copyRewriteRoute, jsonRoute, requestText, seedApp } from "@muselaunch/agents/testing";
import { sceneWords, videoChangeLine } from "@muselaunch/autopilot";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { NeedsYouResponse, TodayResponse } from "@muselaunch/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * Creator → Today (GET /apps/:appId/today) and "Tell Muse what to change" (POST /posts/:id/change):
 * the posts waiting on the person with their video, time reason and the same publish decision as
 * Needs you; a video change runs the Studio's AI edit, the brand gate and a final render, then the
 * post uses the new render and asks for approval again; a caption change rewrites the copy and runs
 * the fact check again. Fixture model routes only (labelled stubs for renders and reviews).
 */

// biome-ignore lint: loose JSON in tests
type J = any;

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const send = (method: string) => async (path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as J };
  };
  return { get: send("GET"), post: send("POST") };
}

describe("Today and “Tell Muse what to change”", () => {
  const knobs = { sameCopy: false };
  // A rewrite that changes nothing (the model ignored the ask): the change fails honestly.
  const same = jsonRoute("CopyRewrite", (req) => {
    const items = (requestText(req).split("The post's copy now (JSON lines):")[1] ?? "").split("\n").filter((l) => l.startsWith('{"id":')).map((l) => JSON.parse(l) as { id: string; text: string });
    return { items, summary: "Kept it" };
  });
  const lazyRewrite: typeof same = (req, i) => (knobs.sameCopy ? same(req, i) : undefined);
  const h = autopilotPlatform({ routes: [lazyRewrite, copyRewriteRoute()] });
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, "alice"); // owner
  const eddie = client(app, "eddie"); // editor
  const carol = client(app, "carol"); // viewer
  const bob = client(app, "bob"); // another workspace
  let wsA = "";
  let appId = "";
  let posts: J[] = [];
  const W = () => `/v1/workspaces/${wsA}`;
  const ws = () => p.db.ws(wsA);
  const getToday = async (c = alice) => {
    const r = await c.get(`${W()}/apps/${appId}/today`);
    expect(r.status).toBe(200);
    return TodayResponse.parse(r.body);
  };

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await bob.post("/v1/workspaces", { name: "Bob Studio" });
    await p.db.top("workspaces").update(wsA, { planId: "studio" });
    await p.credits.grant(wsA, 1000, { reason: "test", idempotencyKey: "today-test", actor: "system" });
    appId = (await seedApp(p, wsA)).appId;
    for (const [who, email, role] of [
      [eddie, "eddie@example.com", "editor"],
      [carol, "carol@example.com", "viewer"],
    ] as const) {
      const inv = await alice.post(`${W()}/invites`, { email, role });
      expect((await who.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
    }
    const started = await alice.post(`${W()}/apps/${appId}/autopilot`, { goal: "More installs from students", maxCredits: 400, autoApproveCredits: 100, variants: 2 });
    expect(started.status).toBe(202);
    await p.inline!.drain();
    posts = (await alice.get(`${W()}/autopilots/${started.body.autopilot.id}`)).body.posts;
  });

  it("says what changed in one plain line", () => {
    expect(sceneWords([3, 1])).toBe("scenes 1 and 3");
    expect(sceneWords([4, 1, 2])).toBe("scenes 1, 2 and 4");
    expect(videoChangeLine("Made the opening shorter.", [1])).toBe("Made the opening shorter (scene 1)");
    expect(videoChangeLine(undefined, [])).toBe("Changed the video");
  });

  it("lists the posts waiting for approval: the video, where and when (with where the time comes from) and the same decision as Needs you", async () => {
    expect(posts).toHaveLength(2);
    expect(posts.every((x: J) => x.status === "awaiting_approval")).toBe(true);
    const t = await getToday();
    const needs = NeedsYouResponse.parse((await alice.get(`${W()}/needs-you?appId=${appId}`)).body);
    expect(t.posts.map((x) => x.id)).toEqual(needs.items.filter((i) => i.kind === "post").map((i) => i.subject.id));
    const first = t.posts[0]!;
    expect(first.decision).toEqual(needs.items.find((i) => i.subject.id === first.id));
    expect(first.decision).toMatchObject({ kind: "post", canDecide: true, approve: { path: expect.stringMatching(/^\/approvals\/.+\/approve$/) } });
    expect(first.video).toMatchObject({ kind: "video", assetId: expect.stringMatching(/^ast_render_/) });
    expect(first).toMatchObject({ channel: "instagram", mode: "manual", account: null, change: null, canChange: true, compositionVersion: expect.any(Number) });
    // No connected account on this deployment: it says why the person posts it themselves.
    expect(first.manualReason).toBeTruthy();
    // A stored time keeps its stored reason; never shown as research when it's a general starting point.
    if (first.scheduledAt) expect(first.timeReason).toBeTruthy();
    if (first.timeReason?.includes("General starting point")) expect(first.timeBasis).toBe("suggested");
    expect(first.copyText).toContain(first.caption);
    expect(t.needs.every((i) => i.kind !== "post")).toBe(true);
    expect(t.videos).toHaveLength(2);
    expect(t.videos[0]).toMatchObject({ assetId: expect.stringMatching(/^ast_render_/), title: expect.any(String) });
  });

  it("everyone in the workspace can read Today; only editors can ask for a change; other workspaces can't see it", async () => {
    const t = await getToday(carol);
    expect(t.posts[0]!.canChange).toBe(false);
    expect(t.posts[0]!.decision?.canDecide).toBe(false);
    expect((await carol.post(`${W()}/posts/${posts[0].id}/change`, { part: "video", instruction: "Make it shorter" })).status).toBe(403);
    expect((await bob.get(`${W()}/apps/${appId}/today`)).status).toBe(404);
    expect((await bob.post(`${W()}/posts/${posts[0].id}/change`, { part: "video", instruction: "Make it shorter" })).status).toBe(404);
  });

  it("says what a change costs before anything is spent", async () => {
    const video = (await alice.get(`${W()}/posts/${posts[0].id}/change/estimate?part=video`)).body;
    expect(video.breakdown[0]).toEqual({ label: "Change the video (Muse Spark)", credits: 3 });
    expect(video.credits).toBe(video.breakdown.reduce((n: number, b: J) => n + b.credits, 0));
    expect(video.credits).toBeGreaterThan(3); // + the final render
    expect(video.available).toBeGreaterThan(0);
    const caption = (await alice.get(`${W()}/posts/${posts[0].id}/change/estimate?part=caption`)).body;
    expect(caption).toMatchObject({ credits: 2 });
    expect((await alice.get(`${W()}/posts/${posts[0].id}/change/estimate?part=sound`)).status).toBe(422);
  });

  it("a video change: Muse Spark edits the editable video, it's rendered again, the post uses the new render and asks for approval again", async () => {
    const id = posts[0].id;
    const before = await ws().collection("scheduledPosts").getOrThrow(id);
    const oldApproval = before.approvalId!;
    const comp = await ws().collection("compositions").getOrThrow(before.compositionId!);
    const renders = h.rendered.length;

    const r = await eddie.post(`${W()}/posts/${id}/change`, { part: "video", instruction: "Make the opening shorter", spoken: true });
    expect(r.status).toBe(202);
    expect(r.body.change).toMatchObject({ part: "video", status: "editing", spoken: true, hadApproval: true, fromVersion: comp.currentVersion, by: "eddie" });
    expect(r.body.job).toMatchObject({ type: "composition.edit", payload: { compositionId: comp.id, baseVersion: comp.currentVersion, autoApply: true, sceneIds: [] } });
    // One change at a time.
    expect((await alice.post(`${W()}/posts/${id}/change`, { part: "caption", instruction: "Shorter" })).status).toBe(409);
    await p.inline!.drain();

    const after = await ws().collection("scheduledPosts").getOrThrow(id);
    const edited = await ws().collection("compositions").getOrThrow(comp.id);
    expect(edited.currentVersion).toBe(comp.currentVersion + 1);
    expect(h.rendered.length).toBe(renders + 1);
    expect(after.compositionVersion).toBe(edited.currentVersion);
    expect(after.assetIds[0]).toBe(`ast_render_${comp.id.slice(-12)}_v${edited.currentVersion}`);
    expect(after.assetIds).not.toContain(before.assetIds[0]);
    expect(after.change).toMatchObject({ status: "done", toVersion: edited.currentVersion, summary: "Replaced the flagged headline (scene 1)" });
    expect(after.change!.note).toBeUndefined();
    // The approval for the old video expired; the new version waits for its own OK (a new snapshot).
    expect((await ws().collection("approvals").getOrThrow(oldApproval)).status).toBe("expired");
    expect(after.status).toBe("awaiting_approval");
    expect(after.approvalId).not.toBe(oldApproval);
    const fresh = await ws().collection("approvals").getOrThrow(after.approvalId!);
    expect(fresh.snapshotHash).not.toBe((await ws().collection("approvals").getOrThrow(oldApproval)).snapshotHash);
    const t = await getToday();
    const card = t.posts.find((x) => x.id === id)!;
    expect(card.decision?.approve?.path).toBe(`/approvals/${after.approvalId}/approve`);
    expect(card.video?.assetId).toBe(after.assetIds[0]);
    expect(card.change?.summary).toBe("Replaced the flagged headline (scene 1)");
    expect(t.videos.find((v) => v.compositionId === comp.id)).toMatchObject({ version: edited.currentVersion, assetId: after.assetIds[0] });
    // Approving it goes through the same route and snapshot check as Needs you.
    expect((await alice.post(`${W()}${card.decision!.approve!.path}`, card.decision!.approve!.body)).status).toBe(200);
    expect((await ws().collection("scheduledPosts").getOrThrow(id)).status).toBe("manual_post_needed");
  });

  it("an approved post you post yourself stays on Today, and can still change (it then needs approval again)", async () => {
    const t = await getToday();
    const mine = t.posts.find((x) => x.id === posts[0].id)!;
    expect(mine).toMatchObject({ status: "manual_post_needed", decision: null, canChange: true });
    // Waiting for approval comes first.
    expect(t.posts[0]!.id).toBe(posts[1].id);
  });

  it("a caption change: Muse Spark rewrites the copy as asked, the fact check runs again, the post shows it and asks for approval again", async () => {
    const id = posts[0].id;
    const before = await ws().collection("scheduledPosts").getOrThrow(id);
    const r = await alice.post(`${W()}/posts/${id}/change`, { part: "caption", instruction: "Make it shorter" });
    expect(r.status).toBe(202);
    expect(r.body.change).toMatchObject({ part: "caption", status: "rewriting", hadApproval: true });
    expect(r.body.job).toMatchObject({ type: "post.revise_copy", payload: { postId: id, instruction: "Make it shorter" } });
    await p.inline!.drain();
    const after = await ws().collection("scheduledPosts").getOrThrow(id);
    expect(after.caption).not.toBe(before.caption);
    expect(after.caption.length).toBeLessThan(before.caption.length);
    expect(after.change).toMatchObject({ status: "done", summary: "Fixture: made the caption shorter" });
    const pack = await ws().collection("copyPacks").getOrThrow(after.copyPackId!);
    expect(pack.revisionOf).toBe(before.copyPackId);
    expect(pack.validation?.ok).toBe(true);
    expect(after.status).toBe("awaiting_approval");
    expect(after.approvalId).not.toBe(before.approvalId);
    expect((await alice.get(`${W()}/jobs/${r.body.job.id}`)).body.job).toMatchObject({ status: "succeeded", creditsCharged: 2 });
  });

  it("a change Muse couldn't make leaves the post as it was and says so", async () => {
    const id = posts[1].id;
    const before = await ws().collection("scheduledPosts").getOrThrow(id);
    knobs.sameCopy = true;
    expect((await alice.post(`${W()}/posts/${id}/change`, { part: "caption", instruction: "Make it friendlier" })).status).toBe(202);
    await p.inline!.drain();
    knobs.sameCopy = false;
    const after = await ws().collection("scheduledPosts").getOrThrow(id);
    expect(after.change).toMatchObject({ status: "failed" });
    expect(after.change!.note).toMatch(/left the caption as it was\. Try saying it another way\. The caption is as it was\.$/);
    expect(after).toMatchObject({ caption: before.caption, status: "awaiting_approval", approvalId: before.approvalId });
    // It can be asked again straight away.
    expect((await alice.post(`${W()}/posts/${id}/change`, { part: "caption", instruction: "Make it friendlier" })).status).toBe(202);
    await p.inline!.drain();
    expect((await ws().collection("scheduledPosts").getOrThrow(id)).change).toMatchObject({ status: "done", summary: "Fixture: made the caption more upbeat" });
  });

  it("a post that is out (or cancelled) can't change", async () => {
    await alice.post(`${W()}/posts/${posts[1].id}/cancel`);
    const r = await alice.post(`${W()}/posts/${posts[1].id}/change`, { part: "video", instruction: "Make it shorter" });
    expect(r.status).toBe(409);
    expect(r.body.error.userMessage).toBe("This post was cancelled, so it can’t change.");
    expect((await alice.post(`${W()}/posts/${posts[0].id}/change`, { part: "video", instruction: "x" })).status).toBe(422);
  });
});
