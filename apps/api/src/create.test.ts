import { seedApp } from "@muselaunch/agents/testing";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * Create's "Generate video" (apps/web/src/features/create): ONE video from a prompt through the
 * existing routes, the same calls a person makes on the campaign page: the campaign request (origin
 * "create", one video deliverable in the chosen format and length, the idea it uses) → the ideas →
 * select + produce the chosen one → plan → editable video → the final render (the render route runs
 * the facts and brand check first). Fixture model routes only; renders and reviews are labelled stubs.
 */

// biome-ignore lint: loose JSON in tests
type J = any;

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const send = (method: string) => async (path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as J };
  };
  return { get: send("GET"), post: send("POST") };
}

const oneVideo = (over: Record<string, unknown> = {}) => ({
  request: "Show how Distraction blocking keeps a study session calm.",
  goal: "feature_announcement",
  channels: ["instagram"],
  deliverables: [{ kind: "feature_promo", channel: "instagram", aspectRatio: "1:1", durationSec: 20, count: 1 }],
  conceptCount: 3,
  origin: "create",
  ...over,
});

describe("Create → Generate video: one finished, editable video through the existing routes", () => {
  const h = autopilotPlatform();
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, "alice"); // owner
  const carol = client(app, "carol"); // viewer
  const bob = client(app, "bob"); // another workspace
  let wsA = "";
  let appId = "";
  const W = () => `/v1/workspaces/${wsA}`;
  const ws = () => p.db.ws(wsA);

  const opportunity = async (title: string) =>
    ws()
      .collection("opportunities")
      .create(
        {
          appId,
          title,
          topic: "Study-with-me videos",
          audience: "Students",
          whyRelevant: "Students post focus sessions.",
          proposedAngle: "Film one calm session.",
          confidence: 0.7,
          evidence: [{ kind: "url", url: "https://trends.example.com/study", title: "Study trend", retrievedAt: new Date().toISOString() }],
          contentType: "short_video",
          effort: "low",
          observedAt: new Date().toISOString(),
          score: 70,
          status: "new",
        },
        { actor: "seed" },
      );

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await bob.post("/v1/workspaces", { name: "Bob Studio" });
    await p.credits.grant(wsA, 1000, { reason: "test", idempotencyKey: "create-test", actor: "system" });
    appId = (await seedApp(p, wsA)).appId;
    const inv = await alice.post(`${W()}/invites`, { email: "carol@example.com", role: "viewer" });
    expect((await carol.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
  });

  it("makes the video: request → the chosen idea in the chosen format and length → editable video → brand check → final render", async () => {
    const opp = await opportunity("Study-with-me timer videos");
    const created = await alice.post(`${W()}/apps/${appId}/campaigns`, oneVideo({ goal: "awareness", deliverables: [{ kind: "short_video", channel: "instagram", aspectRatio: "1:1", durationSec: 20, count: 1 }], opportunityIds: [opp.id] }), { "idempotency-key": "create-test-run-1" });
    expect(created.status).toBe(202);
    const campaignId = created.body.campaign.id as string;
    expect(created.body.campaign).toMatchObject({ origin: "create", channels: ["instagram"], deliverables: [{ kind: "short_video", aspectRatio: "1:1", durationSec: 20, count: 1 }], opportunityIds: [opp.id] });
    expect(created.body.job.type).toBe("campaign.generate_concepts");
    // The idea it uses is linked like Discover's "Make a video".
    expect(await ws().collection("opportunities").get(opp.id)).toMatchObject({ status: "used", campaignId });

    await p.inline!.drain();
    const ideas = (await alice.get(`${W()}/campaigns/${campaignId}`)).body;
    expect(ideas.variants.length).toBeGreaterThanOrEqual(3);
    // The founder's length holds for every idea.
    for (const v of ideas.variants) expect(v.targetDurationSec).toBe(20);

    // What Create clicks: select the idea, produce it in the chosen format and length.
    const chosen = ideas.variants[0];
    expect((await alice.post(`${W()}/campaigns/${campaignId}/variants/${chosen.id}/select`)).status).toBe(200);
    const produce = await alice.post(`${W()}/campaigns/${campaignId}/variants/${chosen.id}/produce`, { aspectRatio: "1:1", targetDurationSec: 20 }, { "idempotency-key": `create-produce-${campaignId}` });
    expect(produce.status).toBe(202);
    // A second tab sending the same step gets the same job (deterministic key).
    const again = await alice.post(`${W()}/campaigns/${campaignId}/variants/${chosen.id}/produce`, { aspectRatio: "1:1", targetDurationSec: 20 }, { "idempotency-key": `create-produce-${campaignId}` });
    expect(again.body.job.id).toBe(produce.body.job.id);
    await p.inline!.drain();

    const made = (await alice.get(`${W()}/campaigns/${campaignId}`)).body;
    expect(made.storyboards).toHaveLength(1);
    expect(made.storyboards[0]).toMatchObject({ aspectRatio: "1:1", targetDurationSec: 20, variantId: chosen.id });
    expect(made.compositions).toHaveLength(1);
    const comp = made.compositions[0];
    expect(comp).toMatchObject({ aspectRatio: "1:1", campaignId, variantId: chosen.id });

    // Finish it: the render route checks facts and the brand, then queues the final render.
    const final = await alice.post(`${W()}/compositions/${comp.id}/render`, { quality: "final", version: comp.currentVersion }, { "idempotency-key": `create-final-${comp.id}-v${comp.currentVersion}` });
    expect(final.status).toBe(202);
    expect(final.body.job.type).toBe("render.final");
    expect(final.body.brandReview.status).toBeTruthy();
    await p.inline!.drain();

    const renders = (await alice.get(`${W()}/assets?appId=${appId}&role=render`)).body.items as J[];
    expect(renders.some((a) => a.render?.compositionId === comp.id && a.render.quality === "final" && a.status === "ready")).toBe(true);
    // Nothing was posted or even drafted.
    expect((await ws().collection("scheduledPosts").list({ where: [["appId", "==", appId]], limit: 10 })).items).toHaveLength(0);
  });

  it("asks for exactly one video and keeps hand-planned campaigns as they were", async () => {
    for (const deliverables of [
      [],
      [{ kind: "short_video", aspectRatio: "9:16", durationSec: 20, count: 2 }],
      [{ kind: "static_ad", aspectRatio: "1:1", count: 1 }],
      [
        { kind: "short_video", aspectRatio: "9:16", count: 1 },
        { kind: "short_video", aspectRatio: "1:1", count: 1 },
      ],
    ]) {
      const r = await alice.post(`${W()}/apps/${appId}/campaigns`, oneVideo({ deliverables }));
      expect(r.status, JSON.stringify(deliverables)).toBe(400);
    }
    // Without origin (Make): no origin stored, and the opportunity isn't marked as used.
    const opp = await opportunity("Exam season focus");
    const make = await alice.post(`${W()}/apps/${appId}/campaigns`, { request: "Three Reels for students", opportunityIds: [opp.id] });
    expect(make.status).toBe(202);
    expect(make.body.campaign.origin).toBeUndefined();
    expect((await ws().collection("opportunities").get(opp.id))?.status).toBe("new");
  });

  it("only editors start it, only in their workspace, and only with the app's own ideas", async () => {
    expect((await carol.post(`${W()}/apps/${appId}/campaigns`, oneVideo())).status).toBe(403);
    expect((await bob.post(`${W()}/apps/${appId}/campaigns`, oneVideo())).status).toBe(404);
    expect((await alice.post(`${W()}/apps/${appId}/campaigns`, oneVideo({ opportunityIds: ["opp_not_here"] }))).status).toBe(400);
  });

  it("without enough credits nothing starts and no campaign is left waiting", async () => {
    const before = (await alice.get(`${W()}/apps/${appId}/campaigns`)).body.items.length;
    const bal = await p.credits.balance(wsA);
    await p.credits.reserve(wsA, bal.available, { operation: "test", idempotencyKey: "create-test-drain", actor: "system" });
    const r = await alice.post(`${W()}/apps/${appId}/campaigns`, oneVideo());
    expect(r.status).toBe(402);
    expect(r.body.error.code).toBe("INSUFFICIENT_CREDITS");
    expect((await alice.get(`${W()}/apps/${appId}/campaigns`)).body.items.length).toBe(before);
  });
});
