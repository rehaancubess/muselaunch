import { handlers as agentHandlers } from "@muselaunch/agents";
import { fixture, fixtureJson, installFakeMeta, installFakeWeb, jsonRoute, png, requestText, resolvePlaceholders, searchRoute, textRoute, toolNames, wonderRoute } from "@muselaunch/agents/testing";
import { createTestPlatform, type JobContext } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

// biome-ignore lint: loose JSON in tests
type J = any;
const json = async (r: Response): Promise<J> => r.json();

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const send = (method: string) => (path: string, body?: unknown) =>
    app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { get: (path: string) => app.request(path, { headers: auth }), post: send("POST"), patch: send("PATCH"), del: send("DELETE") };
}

const IOS_URL = "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890";

describe("module B API (app-dna.ts + campaigns.ts) with fixture-backed Meta", () => {
  const built: string[] = [];
  const p = createTestPlatform({ META_API_KEY: "test-key" }, {
    ...agentHandlers,
    "media.probe": async () => ({}),
    "composition.build": async (ctx: JobContext<"composition.build">) => {
      built.push(ctx.payload.compositionId);
      return { creditsUsed: 0 };
    },
    // Module D's b-roll step (not exercised here): pass straight through to the build.
    "storyboard.resolve_media": async (ctx: JobContext<"storyboard.resolve_media">) => {
      const build = await ctx.enqueue("composition.build", ctx.payload, { idempotencyKey: `composition.build:${ctx.payload.storyboardId}` });
      return { data: { buildJobId: build.id } };
    },
  });
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  let wsA = "";
  let wsB = "";
  let appId = "";
  let campaignId = "";
  const W = () => `/v1/workspaces/${wsA}`;

  beforeAll(async () => {
    const shot = await png([250, 250, 250]);
    const icon = await png([92, 70, 220], [64, 64], [255, 190, 0]);
    installFakeWeb(p, [
      { match: "https://itunes.apple.com/lookup?id=1234567890&country=us", contentType: "text/javascript", body: fixture("itunes-lookup.json") },
      { match: /mzstatic\.com\/image\/thumb\/fixture\/icon/, contentType: "image/png", body: icon },
      { match: /mzstatic\.com\/image\/thumb\/fixture\/shot/, contentType: "image/png", body: shot },
      { match: "https://calmstudy.example.com/about", contentType: "text/html", body: "<html><body>CalmStudy study-with-me. Business inquiries: hello@calmstudy.example.com</body></html>" },
    ]);
    installFakeMeta(p, [
      jsonRoute("AppDna", (req) => resolvePlaceholders(fixtureJson("spark-app-dna.json"), req)),
      jsonRoute("CampaignConcepts", (req) => resolvePlaceholders(fixtureJson("spark-concepts.json"), req)),
      jsonRoute("Storyboard", (req) => resolvePlaceholders(fixtureJson("spark-storyboard-repaired.json"), req)),
      jsonRoute("CopyPacks", (req) => resolvePlaceholders(fixtureJson<{ repaired: unknown }>("spark-copy.json").repaired, req)),
      jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) })),
      wonderRoute(fixtureJson<{ turns: { name: string; args: unknown }[][] }>("wonder-strategy-turns.json").turns, (r) => toolNames(r).includes("set_strategy")),
      wonderRoute(fixtureJson<{ turns: { name: string; args: unknown }[][] }>("wonder-research-turns.json").turns, (r) => toolNames(r).includes("save_finding")),
      searchRoute(),
      textRoute("Summarise these research findings", "Sources report study-with-me timer videos recur. This may mean the timer screen is a natural hook."),
    ]);
    wsA = (await json(await alice.post("/v1/workspaces", { name: "Alice Apps" }))).workspace.id;
    wsB = (await json(await bob.post("/v1/workspaces", { name: "Bob Studio" }))).workspace.id;
  });

  it("import → App DNA via the API, user edits survive a refresh, confirm makes the app ready", async () => {
    const created = await alice.post(`${W()}/apps`, { appStoreUrl: IOS_URL });
    expect(created.status).toBe(202);
    appId = (await json(created)).app.id;
    // Campaigns are refused until App DNA exists (failure path).
    expect((await alice.post(`${W()}/apps/${appId}/campaigns`, { request: "Three reels" })).status).toBe(409);
    await p.inline!.drain();
    const dna = await json(await alice.get(`${W()}/apps/${appId}/dna`));
    expect(dna.profile.features.length).toBe(3);
    expect(dna.evidence.length).toBeGreaterThan(5);
    expect(dna.claims.find((c: J) => c.text === "Block distracting apps during focus sessions").state).toBe("verified");
    expect(dna.import.status).toBe("succeeded");

    const patched = await json(await alice.patch(`${W()}/apps/${appId}/dna`, { oneLiner: "Calm focus, one tap away", tone: { voice: ["calm", "warm"] }, prohibitedClaims: ["works offline"] }));
    expect(patched.profile.userEditedPaths).toEqual(expect.arrayContaining(["oneLiner", "tone.voice", "prohibitedClaims"]));
    expect(patched.profile.tone.vocabularyAvoid).toEqual(["hustle"]); // untouched nested field kept
    expect((await alice.patch(`${W()}/apps/${appId}/dna`, { bogus: 1 })).status).toBe(422);

    expect((await alice.post(`${W()}/apps/${appId}/dna/analyze`)).status).toBe(202);
    await p.inline!.drain();
    const refreshed = await json(await alice.get(`${W()}/apps/${appId}/dna`));
    expect(refreshed.profile.oneLiner).toBe("Calm focus, one tap away");
    expect(refreshed.profile.version).toBe(3);

    const confirmed = await json(await alice.post(`${W()}/apps/${appId}/dna/confirm`));
    expect(confirmed.app).toMatchObject({ status: "ready", dnaStatus: "confirmed" });
    expect(confirmed.profile.status).toBe("confirmed");
  });

  it("claims, competitors and memory endpoints (with honest Glimmer status)", async () => {
    const claim = await json(await alice.post(`${W()}/apps/${appId}/claims`, { text: "Sessions from 10 to 90 minutes" }));
    expect(claim.claim).toMatchObject({ state: "verified", origin: "user" });
    const dna = await json(await alice.get(`${W()}/apps/${appId}/dna`));
    const speculative = dna.claims.find((c: J) => c.text.startsWith("The #1"));
    const rejected = await json(await alice.patch(`${W()}/apps/${appId}/claims/${speculative.id}`, { state: "rejected", note: "Not provable" }));
    expect(rejected.claim.state).toBe("rejected");
    expect(rejected.claim.history.at(-1)).toMatchObject({ from: "needs_review", to: "rejected", by: "alice" });

    expect((await alice.post(`${W()}/apps/${appId}/competitors`, { name: "Evil", websiteUrl: "http://169.254.169.254/x" })).status).toBe(400);
    const comp = await json(await alice.post(`${W()}/apps/${appId}/competitors`, { name: "Forest", websiteUrl: "https://www.forestapp.cc" }));
    expect(comp.competitor.origin).toBe("user");
    expect((await json(await alice.get(`${W()}/apps/${appId}/competitors`))).items).toHaveLength(1);

    await p.inline!.drain();
    const mem = await json(await alice.get(`${W()}/apps/${appId}/memory`));
    expect(mem.glimmer.connected).toBe(false);
    expect(mem.items.map((x: J) => x.text)).toEqual(expect.arrayContaining(['Do not claim: "works offline"', 'Do not claim: "The #1 focus app for students"']));
    const pref = await json(await alice.post(`${W()}/apps/${appId}/memory`, { kind: "style", text: "Big bold captions, no emojis" }));
    expect((await json(await alice.patch(`${W()}/apps/${appId}/memory/${pref.preference.id}`, { weight: 0.9 }))).preference.weight).toBe(0.9);
    const preview = await json(await alice.get(`${W()}/apps/${appId}/memory/retrieve?task=scene_edit&query=captions`));
    expect(preview.usedGlimmer).toBe(false);
    expect(preview.items[0].id).toBe(pref.preference.id);
    expect((await alice.del(`${W()}/apps/${appId}/memory/${pref.preference.id}`)).status).toBe(200);
    expect((await alice.del(`${W()}/apps/${appId}/competitors/${comp.competitor.id}`)).status).toBe(200);
  });

  it("campaign → concepts → select → produce (storyboard + composition.build) → copy", async () => {
    const res = await alice.post(`${W()}/apps/${appId}/campaigns`, { request: "Create three promotional Reels for students\nPremium Apple-style", goal: "installs", channels: ["instagram", "tiktok"] });
    expect(res.status).toBe(202);
    const body = await json(res);
    campaignId = body.campaign.id;
    expect(body.job.type).toBe("campaign.generate_concepts");
    expect(body.job.reservation.credits).toBe(15);
    await p.inline!.drain();
    const full = await json(await alice.get(`${W()}/campaigns/${campaignId}`));
    expect(full.campaign.status).toBe("concepts_ready");
    expect(full.brief.cta).toBe("Start your first focus session");
    expect(full.variants).toHaveLength(3);
    const v = full.variants.find((x: J) => x.angleType === "practical_demo");
    const sel = await json(await alice.post(`${W()}/campaigns/${campaignId}/variants/${v.id}/select`));
    expect(sel.campaign.selectedVariantIds).toEqual([v.id]);
    const rej = full.variants.find((x: J) => x.angleType === "founder_story");
    expect((await json(await alice.post(`${W()}/campaigns/${campaignId}/variants/${rej.id}/reject`))).variant.status).toBe("rejected");
    expect((await alice.post(`${W()}/campaigns/${campaignId}/variants/${rej.id}/produce`, {})).status).toBe(409);

    const prod = await alice.post(`${W()}/campaigns/${campaignId}/variants/${v.id}/produce`, { aspectRatio: "9:16", targetDurationSec: 15 });
    expect(prod.status).toBe(202);
    await p.inline!.drain();
    const after = await json(await alice.get(`${W()}/campaigns/${campaignId}`));
    expect(after.storyboards).toHaveLength(1);
    expect(after.storyboards[0].scenes.every((s: J) => typeof s.template === "string")).toBe(true);
    expect(built).toHaveLength(1);

    const copy = await alice.post(`${W()}/campaigns/${campaignId}/copy`, { variantId: v.id, channels: ["instagram", "producthunt"] });
    expect(copy.status).toBe(202);
    await p.inline!.drain();
    const withCopy = await json(await alice.get(`${W()}/campaigns/${campaignId}`));
    expect(withCopy.copyPacks.map((x: J) => x.channel).sort()).toEqual(["instagram", "producthunt"]);
    expect(withCopy.copyPacks.find((x: J) => x.channel === "producthunt").validation.ok).toBe(false); // "1,000,000 students" flagged

    const memory = await json(await alice.get(`${W()}/apps/${appId}/memory`));
    expect(memory.items.map((x: J) => x.kind)).toEqual(expect.arrayContaining(["angle_accepted", "angle_rejected"]));
  });

  it("research + strategy with approval checkpoint; agent run detail exposes steps, tool calls, citations and cost", async () => {
    const r = await alice.post(`${W()}/apps/${appId}/research`, { kinds: ["trends", "competitors", "creators", "opportunities"], countries: ["us"] });
    expect(r.status).toBe(202);
    const { researchRun } = await json(r);
    await p.inline!.drain();
    const rr = await json(await alice.get(`${W()}/research-runs/${researchRun.id}`));
    expect(rr.run.status).toBe("succeeded");
    expect(rr.findings.length).toBe(1);
    expect(rr.findings[0].evidence[0].url).toMatch(/^https:\/\//);

    const s = await alice.post(`${W()}/apps/${appId}/strategy`, { goal: "Get 1,000 student installs before exams" });
    expect(s.status).toBe(202);
    const { run } = await json(s);
    await p.inline!.drain();
    const detail = await json(await alice.get(`${W()}/agent-runs/${run.id}`));
    expect(detail.run.status).toBe("needs_approval");
    expect(detail.steps.some((x: J) => x.kind === "approval_request")).toBe(true);
    expect(detail.usage.every((u: J) => u.model === "muse-wonder-1.0" || u.model === "muse-spark-1.3")).toBe(true);
    expect(detail.usage.reduce((n: number, u: J) => n + u.costUsdEstimate, 0)).toBeGreaterThan(0);
    expect(detail.tools.map((t: J) => t.tool)).toEqual(expect.arrayContaining(["set_strategy", "propose_research", "propose_concepts", "finish"]));

    const researchDetail = await json(await alice.get(`${W()}/agent-runs/${rr.run.agentRunId}`));
    expect(researchDetail.steps.some((x: J) => x.citations.length > 0)).toBe(true);

    const approved = await alice.post(`${W()}/agent-runs/${run.id}/approve`);
    expect(approved.status).toBe(202);
    expect((await json(approved)).jobs.map((j: J) => j.type)).toEqual(["research.run", "campaign.generate_concepts"]);
    expect((await alice.post(`${W()}/agent-runs/${run.id}/approve`)).status).toBe(409);
    await p.inline!.drain();
    const runs = await json(await alice.get(`${W()}/apps/${appId}/agent-runs`));
    expect(runs.items.map((x: J) => x.kind)).toEqual(expect.arrayContaining(["app_analysis", "campaign_concepts", "storyboard", "copywriting", "research", "growth_strategy"]));
  });

  it("enforces tenancy and capabilities", async () => {
    // Bob can't reach Alice's workspace or her entities through his own workspace.
    expect((await bob.get(`${W()}/apps/${appId}/dna`)).status).toBe(404);
    expect((await bob.post(`${W()}/apps/${appId}/campaigns`, { request: "x" })).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/apps/${appId}/dna`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/campaigns/${campaignId}`)).status).toBe(404);
    const runs = await json(await alice.get(`${W()}/apps/${appId}/agent-runs`));
    expect((await bob.get(`/v1/workspaces/${wsB}/agent-runs/${runs.items[0].id}`)).status).toBe(404);
    // Viewers can read but not write.
    const inv = await json(await alice.post(`${W()}/invites`, { email: "carol@example.com", role: "viewer" }));
    const carol = client(app, "carol", "carol@example.com");
    await carol.post(`/v1/invites/${inv.acceptUrl.split("/").pop()}/accept`);
    expect((await carol.get(`${W()}/apps/${appId}/dna`)).status).toBe(200);
    expect((await carol.post(`${W()}/apps/${appId}/campaigns`, { request: "x" })).status).toBe(403);
    expect((await carol.patch(`${W()}/apps/${appId}/dna`, { oneLiner: "x" })).status).toBe(403);
    expect((await carol.post(`${W()}/apps/${appId}/memory`, { kind: "style", text: "x" })).status).toBe(403);
  });
});
