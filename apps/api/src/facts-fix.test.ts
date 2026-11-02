import { copyRevisionRoute, factCheckRoute, jsonRoute, requestText, seedApp } from "@muselaunch/agents/testing";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { NeedsYouResponse, PostFactCheck } from "@muselaunch/contracts";
import { handlers as growthHandlers } from "@muselaunch/growth";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * One-tap fixes for a post the fact check held back (routes/publishing.ts → growth/publishing/facts.ts):
 * "Remove it" (Muse Spark rewrites the copy, then it's checked again) and "It's true, add it" (the
 * person's confirmation becomes a sourced fact, then the copy is checked again). Autopilot's drafts
 * then ask for approval as Autopilot would, so they show up in Needs you. Fixture model routes only.
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

/** Post copy that says more than the seeded app's facts back (racing, bowling). */
const CAPTION = "Arcade, racing, bowling & co-op fun for game night. Grab a phone and play: [APP_LINK]";
const copyRoute = jsonRoute("CopyPacks", (req) => ({
  packs: [...requestText(req).matchAll(/^- ([a-z_]+): items /gm)].map((m) => ({ channel: m[1], items: [{ kind: "caption", text: CAPTION }, { kind: "hashtags", text: "#gamenight #arcade" }] })),
}));

describe("Fact check one-tap fixes (POST /posts/:id/facts/remove | confirm)", () => {
  const knobs = { lazyRewrite: false, lenientCheck: false };
  const h = autopilotPlatform({
    handlers: { "post.fix_facts": growthHandlers["post.fix_facts"]! },
    routes: [copyRoute, copyRevisionRoute({ keep: () => knobs.lazyRewrite }), factCheckRoute({ vocabulary: ["racing", "bowling"], statement: (t) => `Tidy Timer has ${t.join(" and ")} games.`, lenient: () => knobs.lenientCheck })],
  });
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, "alice"); // owner
  const eddie = client(app, "eddie"); // editor (no content.approve)
  const carol = client(app, "carol"); // viewer
  let wsA = "";
  let appId = "";
  let apId = "";
  let posts: J[] = [];
  const W = () => `/v1/workspaces/${wsA}`;
  const ws = () => p.db.ws(wsA);
  const view = async (id: string) => (await alice.get(`${W()}/posts/${id}`)).body;
  const needs = async () => NeedsYouResponse.parse((await alice.get(`${W()}/needs-you`)).body);

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await p.db.top("workspaces").update(wsA, { planId: "studio" });
    await p.credits.grant(wsA, 1000, { reason: "test", idempotencyKey: "facts-fix-test", actor: "system" });
    appId = (await seedApp(p, wsA)).appId;
    for (const [who, email, role] of [
      [eddie, "eddie@example.com", "editor"],
      [carol, "carol@example.com", "viewer"],
    ] as const) {
      const inv = await alice.post(`${W()}/invites`, { email, role });
      expect((await who.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
    }
    const started = await alice.post(`${W()}/apps/${appId}/autopilot`, { goal: "More game nights", maxCredits: 400, autoApproveCredits: 100, variants: 2 });
    expect(started.status).toBe(202);
    await p.inline!.drain();
    apId = started.body.autopilot.id;
    const detail = (await alice.get(`${W()}/autopilots/${apId}`)).body;
    expect(detail.autopilot).toMatchObject({ status: "sleeping", stage: "measure" });
    posts = detail.posts;
  });

  it("Autopilot's posts are held back by the fact check, in plain words, with what each fix would do", async () => {
    expect(posts).toHaveLength(2);
    expect(posts.every((x: J) => x.status === "draft")).toBe(true);
    const v = await view(posts[0].id);
    const fc = PostFactCheck.parse(v.factCheck);
    expect(fc).toMatchObject({ ok: false, message: "This post mentions racing and bowling, which aren’t in your confirmed facts yet.", quotes: ["racing, bowling"], statements: ["Tidy Timer has racing and bowling games."] });
    expect(v.preflight.errors[0]).toBe("This post mentions racing and bowling, which aren’t in your confirmed facts yet. Remove it or confirm it as a fact, then ask for approval.");
    expect(fc.preflightError).toBe(v.preflight.errors[0]);
    // Autopilot noted why it left the drafts, and nothing reached Needs you.
    const ap = await ws().collection("autopilots").getOrThrow(apId);
    expect(ap.log.some((e) => e.summary.includes("approval can't be requested yet: This post mentions racing and bowling"))).toBe(true);
    expect((await needs()).items.filter((i) => i.kind === "post")).toEqual([]);
  });

  it("only people who can edit content (and facts) can fix it; an editor's fact waits for an owner or admin", async () => {
    const id = posts[0].id;
    expect((await carol.post(`${W()}/posts/${id}/facts/remove`)).status).toBe(403);
    expect((await carol.post(`${W()}/posts/${id}/facts/confirm`, {})).status).toBe(403);

    const r = await eddie.post(`${W()}/posts/${id}/facts/confirm`, {});
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ confirmed: false, job: null });
    expect(r.body.claims[0]).toMatchObject({ text: "Tidy Timer has racing and bowling games.", state: "needs_review", origin: "user", speculative: false });
    expect(r.body.evidence[0]).toMatchObject({ reviewState: "needs_review", source: { kind: "user_input", publisher: "Founder-confirmed" } });
    // Not confirmed yet: the post stays held back and no re-check ran.
    expect((await view(id)).factCheck.ok).toBe(false);
    expect((await ws().collection("scheduledPosts").getOrThrow(id)).status).toBe("draft");
  });

  it("never-say wording can't be confirmed as a fact", async () => {
    const r = await alice.post(`${W()}/posts/${posts[0].id}/facts/confirm`, { statements: ["Tidy Timer works offline with racing games"] });
    expect(r.status).toBe(400);
    expect(r.body.error.userMessage).toMatch(/never-say list/);
  });

  it("“Remove it”: a rewrite that keeps a flagged word stays held back, even when the model check misses it", async () => {
    const id = posts[1].id;
    knobs.lazyRewrite = true;
    knobs.lenientCheck = true;
    const r = await alice.post(`${W()}/posts/${id}/facts/remove`);
    expect(r.status).toBe(202);
    expect(r.body.job).toMatchObject({ type: "post.fix_facts", payload: { action: "remove", postId: id } });
    // A second tap while it runs is refused instead of starting a duplicate.
    expect((await alice.post(`${W()}/posts/${id}/facts/remove`)).status).toBe(409);
    await p.inline!.drain();
    knobs.lazyRewrite = false;
    knobs.lenientCheck = false;
    const job = (await alice.get(`${W()}/jobs/${r.body.job.id}`)).body.job;
    expect(job).toMatchObject({ status: "succeeded", creditsCharged: 2 });
    const post = await ws().collection("scheduledPosts").getOrThrow(id);
    expect(post.status).toBe("draft");
    expect(post.approvalId).toBeUndefined();
    const pack = await ws().collection("copyPacks").getOrThrow(post.copyPackId!);
    const original = await ws().collection("copyPacks").getOrThrow(pack.revisionOf!);
    expect(original.items[0]!.text).toBe(CAPTION); // the original pack is kept as it was
    expect(pack.validation?.ok).toBe(false);
    expect(pack.validation?.issues.map((i) => i.issue)).toEqual(['Still mentions "racing", "bowling" after the rewrite']);
  });

  it("“Remove it”: the rewritten copy passes, the post shows it and Autopilot's approval request reaches Needs you", async () => {
    const id = posts[1].id;
    const r = await eddie.post(`${W()}/posts/${id}/facts/remove`); // editors can rewrite copy
    expect(r.status).toBe(202);
    await p.inline!.drain();
    const post = await ws().collection("scheduledPosts").getOrThrow(id);
    expect(post.caption).not.toMatch(/racing|bowling/i);
    expect(post.caption).toMatch(/^Arcade & co-op fun for game night/);
    expect(post.status).toBe("awaiting_approval");
    const pack = await ws().collection("copyPacks").getOrThrow(post.copyPackId!);
    expect(pack.validation).toMatchObject({ ok: true, issues: [] });
    const v = await view(id);
    expect(v.factCheck.ok).toBe(true);
    expect(v.preflight.errors).toEqual([]);
    const item = (await needs()).items.find((i) => i.subject.id === id);
    expect(item).toMatchObject({ kind: "post", canDecide: true, approve: { path: `/approvals/${post.approvalId}/approve` } });
    const ap = await ws().collection("autopilots").getOrThrow(apId);
    expect(ap.log.at(-1)!.summary).toBe("Post fact check: Removed the words the fact check flagged; the post passes the fact check and is waiting for your OK.");
    // Fixed: nothing left to remove or confirm.
    expect((await alice.post(`${W()}/posts/${id}/facts/remove`)).status).toBe(409);
  });

  it("“It's true, add it”: the owner's confirmation becomes a sourced, founder-confirmed fact; the copy passes and approval is requested", async () => {
    const id = posts[0].id;
    const r = await alice.post(`${W()}/posts/${id}/facts/confirm`, {});
    expect(r.status).toBe(202);
    expect(r.body.confirmed).toBe(true);
    await p.inline!.drain();
    const claim = r.body.claims[0];
    const dna = (await alice.get(`${W()}/apps/${appId}/dna`)).body;
    const stored = dna.claims.find((c: J) => c.id === claim.id);
    // The editor's earlier fact is the same one: now confirmed by the owner, citing the founder's confirmation.
    expect(stored).toMatchObject({ text: "Tidy Timer has racing and bowling games.", state: "verified", origin: "user", reviewedBy: "alice" });
    expect(stored.history.map((x: J) => x.to)).toEqual(["needs_review", "verified"]);
    const ev = dna.evidence.find((e: J) => e.id === stored.evidenceIds[0]);
    expect(ev).toMatchObject({ reviewState: "verified", fact: "Tidy Timer has racing and bowling games.", source: { kind: "user_input", publisher: "Founder-confirmed", excerpt: "The post said: “racing, bowling”" } });

    const post = await ws().collection("scheduledPosts").getOrThrow(id);
    expect(post.caption).toBe(`${CAPTION}\n\n#gamenight #arcade`); // the words didn't change, only what backs them
    expect(post.status).toBe("awaiting_approval");
    expect((await view(id)).factCheck).toMatchObject({ ok: true, fix: { action: "recheck", status: "succeeded" } });
    const items = (await needs()).items.filter((i) => i.kind === "post");
    expect(items.map((i) => i.subject.id).sort()).toEqual([posts[0].id, posts[1].id].sort());
  });

  it("a post someone made by hand (and a pack checked before issues had kinds) can be fixed too; its approval stays theirs to request", async () => {
    const campaignId = (await ws().collection("autopilots").getOrThrow(apId)).campaignId!;
    const legacy = await ws().collection("copyPacks").create(
      {
        appId,
        campaignId,
        channel: "instagram",
        items: [{ id: "instagram_1", kind: "caption", text: "Mini golf, arcade & co-op fun tonight.", claimIds: [] }],
        // The exact wording of a pack held back before this change (no kind/quote fields).
        validation: { ok: false, issues: [{ itemId: "instagram_1", issue: '"mini golf" in "Mini golf, arcade & co-op fun" - arcade and co-op are supported but no verified claim or listing evidence mentions golf.' }], checkedAt: new Date().toISOString() },
      },
      { actor: "alice" },
    );
    const shot = (await ws().collection("mediaAssets").list({ where: [["appId", "==", appId]], limit: 50 })).items.find((a) => a.role === "screenshot")!;
    const created = await alice.post(`${W()}/apps/${appId}/posts`, { campaignId, assetIds: [shot.id], copyPackId: legacy.id, channel: "instagram" });
    expect(created.status).toBe(201);
    const id = created.body.post.id;
    expect((await view(id)).factCheck).toMatchObject({ ok: false, message: "This post mentions mini golf, which isn’t in your confirmed facts yet.", statements: ["Mini golf, arcade & co-op fun tonight."] });
    expect((await alice.post(`${W()}/posts/${id}/request-approval`)).status).toBe(422);

    // Its flagged words are enforced too: a rewrite that keeps them stays held back.
    knobs.lazyRewrite = true;
    knobs.lenientCheck = true;
    expect((await alice.post(`${W()}/posts/${id}/facts/remove`)).status).toBe(202);
    await p.inline!.drain();
    knobs.lazyRewrite = false;
    knobs.lenientCheck = false;
    expect((await view(id)).factCheck).toMatchObject({ ok: false, message: "This post mentions mini golf, which isn’t in your confirmed facts yet." });

    expect((await alice.post(`${W()}/posts/${id}/facts/remove`)).status).toBe(202);
    await p.inline!.drain();
    const post = await ws().collection("scheduledPosts").getOrThrow(id);
    expect(post.caption).toBe("Arcade & co-op fun tonight.");
    expect(post.status).toBe("draft"); // not Autopilot's: nothing requested on the person's behalf
    expect((await view(id)).preflight.errors).toEqual([]);
    const req = await alice.post(`${W()}/posts/${id}/request-approval`);
    expect(req.status).toBe(200);
    expect(req.body.post.status).toBe("awaiting_approval");
  });
});
