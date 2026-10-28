import { fixture, fixtureJson, installFakeWeb, jsonRoute, png, resolvePlaceholders, seedApp } from "@muselaunch/agents/testing";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

// biome-ignore lint: loose JSON in tests
type J = any;

const IOS_URL = "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890";

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  const send = (method: string) => async (path: string, body?: unknown) => {
    const res = await app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as J };
  };
  return { get: send("GET"), post: send("POST"), patch: send("PATCH") };
}

/**
 * Autopilot by default, through the API: POST /apps starts a run (or explains why not), the workspace
 * setting and its permissions, the one-tap start (GET/POST /apps/:appId/autopilot/auto) and the
 * "Needs you" list (GET /needs-you) whose one-tap decisions go through the existing approval routes.
 */
describe("Autopilot by default (apps.ts, autopilot.ts, needs-you.ts, workspace.ts)", () => {
  const h = autopilotPlatform({ routes: [jsonRoute("AppDna", (req) => resolvePlaceholders(fixtureJson("spark-app-dna.json"), req))] });
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const eddie = client(app, "eddie");
  const carol = client(app, "carol");
  let wsA = "";
  let wsB = "";
  let autoAppId = "";
  const W = () => `/v1/workspaces/${wsA}`;

  beforeAll(async () => {
    const shot = await png([250, 250, 250]);
    const icon = await png([92, 70, 220], [64, 64], [255, 190, 0]);
    installFakeWeb(p, [
      { match: "https://itunes.apple.com/lookup?id=1234567890", contentType: "text/javascript", body: fixture("itunes-lookup.json") },
      { match: /mzstatic\.com\/image\/thumb\/fixture\/icon/, contentType: "image/png", body: icon },
      { match: /mzstatic\.com\/image\/thumb\/fixture\/shot/, contentType: "image/png", body: shot },
    ]);
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).body.workspace.id;
    await p.db.top("workspaces").update(wsA, { planId: "studio" });
    await p.credits.grant(wsA, 1000, { reason: "test", idempotencyKey: "autodefault-test", actor: "system" });
    for (const [uid, role] of [
      ["eddie", "editor"],
      ["carol", "viewer"],
    ] as const) {
      const inv = await alice.post(`${W()}/invites`, { email: `${uid}@example.com`, role });
      expect((await client(app, uid).post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
    }
  });

  it("new workspaces default to Autopilot on (existing data without the setting parses to the default)", async () => {
    const ws = await alice.get(W());
    expect(ws.body.workspace.settings.autopilot).toEqual({ enabled: true, autoApproveRenders: true });
    const raw = await p.db.top("workspaces").get(wsB);
    const legacy = { ...raw!, settings: { defaultTimezone: "UTC", defaultLocale: "en", metaDataMode: "standard" } };
    await p.db.top("workspaces").set(wsB, legacy as never);
    expect((await bob.get(`/v1/workspaces/${wsB}`)).body.workspace.settings.autopilot).toEqual({ enabled: true, autoApproveRenders: true });
  });

  it("POST /apps with a store link starts Growth Autopilot; it runs to Needs you (posts) with no other input", async () => {
    const created = await alice.post(`${W()}/apps`, { appStoreUrl: IOS_URL });
    expect(created.status).toBe(202);
    expect(created.body.job.type).toBe("app.import");
    expect(created.body.autopilot).toMatchObject({ started: true, plan: { variants: 2, fits: true, goalFromDna: false } });
    autoAppId = created.body.app.id;
    await p.inline!.drain();
    const loop = await alice.get(`${W()}/autopilots/${created.body.autopilot.autopilotId}`);
    expect(loop.body.autopilot).toMatchObject({ status: "sleeping", stage: "measure", goal: "Get more installs of Tidy Timer from students" });
    expect((await alice.get(`${W()}/apps/${autoAppId}`)).body.app.dnaStatus).toBe("confirmed");
    const audit = await alice.get(`${W()}/audit`);
    expect(audit.body.items.some((e: J) => e.action === "autopilot.auto_started")).toBe(true);

    const needs = await alice.get(`${W()}/needs-you?appId=${autoAppId}`);
    expect(needs.status).toBe(200);
    expect(needs.body.count).toBe(2);
    expect(needs.body.items.map((i: J) => i.kind)).toEqual(["post", "post"]);
    // The workspace-wide list (top-bar badge) has them too.
    expect((await alice.get(`${W()}/needs-you`)).body.count).toBeGreaterThanOrEqual(2);
  });

  it("one-tap decisions keep the existing permission and snapshot checks", async () => {
    const [first, second] = (await alice.get(`${W()}/needs-you?appId=${autoAppId}`)).body.items as J[];
    // Viewers and editors see the item but can't decide it (publish needs the separate grant).
    const asCarol = (await carol.get(`${W()}/needs-you?appId=${autoAppId}`)).body.items as J[];
    expect(asCarol.every((i) => i.canDecide === false)).toBe(true);
    expect((await eddie.get(`${W()}/needs-you?appId=${autoAppId}`)).body.items.every((i: J) => !i.canDecide)).toBe(true);
    expect((await eddie.post(`${W()}${first.approve.path}`, first.approve.body)).status).toBe(403);
    expect((await carol.post(`${W()}${first.approve.path}`, first.approve.body)).status).toBe(403);
    // A wrong snapshot is refused; the shown one is accepted.
    expect((await alice.post(`${W()}${first.approve.path}`, { snapshotHash: "sha256:not-what-you-saw" })).status).toBe(409);
    const ok = await alice.post(`${W()}${first.approve.path}`, first.approve.body);
    expect(ok.status).toBe(200);
    expect(ok.body.approval.status).toBe("approved");
    expect(ok.body.post.status).not.toBe("published"); // approval schedules; nothing is published here
    const after = await alice.get(`${W()}/needs-you?appId=${autoAppId}`);
    expect(after.body.items.map((i: J) => i.id)).toEqual([second.id]);
  });

  it("autopilot: false (\"I'll do it myself\") and the workspace setting turn the automatic start off", async () => {
    const manual = await alice.post(`${W()}/apps`, { websiteUrl: "https://tidy.example.com", autopilot: false });
    expect(manual.status).toBe(202);
    expect(manual.body.autopilot).toBeNull();
    const nameOnly = await alice.post(`${W()}/apps`, { name: "Just a name" });
    expect(nameOnly.body.autopilot).toMatchObject({ started: false, code: "no_source" });
    // Settings: workspace.manage to toggle; viewers/editors can't.
    expect((await carol.patch(W(), { settings: { autopilot: { enabled: false } } })).status).toBe(403);
    expect((await eddie.patch(W(), { settings: { autopilot: { enabled: false } } })).status).toBe(403);
    expect((await alice.patch(W(), { settings: { autopilot: { bogus: true } } })).status).toBe(422);
    const off = await alice.patch(W(), { settings: { autopilot: { enabled: false, maxCreditsPerRun: 300 } } });
    expect(off.status).toBe(200);
    expect(off.body.workspace.settings).toMatchObject({ defaultTimezone: "UTC", autopilot: { enabled: false, autoApproveRenders: true, maxCreditsPerRun: 300 } });
    const later = await alice.post(`${W()}/apps`, { websiteUrl: "https://later.example.com" });
    expect(later.body.autopilot).toBeNull();
    expect((await alice.get(`${W()}/apps/${later.body.app.id}/autopilots`)).body.items).toHaveLength(0);
    // Back on; null removes the per-run limit; other settings are kept.
    const on = await alice.patch(W(), { settings: { defaultTimezone: "Europe/Berlin", autopilot: { enabled: true, maxCreditsPerRun: null } } });
    expect(on.body.workspace.settings).toMatchObject({ defaultTimezone: "Europe/Berlin", autopilot: { enabled: true, autoApproveRenders: true } });
    expect(on.body.workspace.settings.autopilot.maxCreditsPerRun).toBeUndefined();
  });

  it("one-tap start: viewers can see the plan but not start; editors start without pre-approved renders; short credits → 402 with a smaller run", async () => {
    const appId = (await seedApp(p, wsA, { name: "Seeded" })).appId;
    const plan = await carol.get(`${W()}/apps/${appId}/autopilot/auto`);
    expect(plan.status).toBe(200);
    expect(plan.body.plan).toMatchObject({ goalFromDna: true, goal: "Get more installs of Seeded from students", fits: true });
    expect(plan.body.settings.enabled).toBe(true);
    expect((await carol.post(`${W()}/apps/${appId}/autopilot/auto`)).status).toBe(403);
    const started = await eddie.post(`${W()}/apps/${appId}/autopilot/auto`);
    expect(started.status).toBe(202);
    expect(started.body.autopilot.budget.autoApproveCredits).toBe(0);
    expect(started.body.plan.notes.join(" ")).toMatch(/only members who manage billing/);
    expect((await eddie.post(`${W()}/apps/${appId}/autopilot/auto`)).status).toBe(409);
    expect((await alice.post(`${W()}/autopilots/${started.body.autopilot.id}/cancel`)).status).toBe(200);

    // Credits short: 402, nothing starts, the plan offers a smaller run.
    const bal = await p.credits.balance(wsA);
    await p.credits.adjust(wsA, -(bal.available - 120), { reason: "test: low balance", idempotencyKey: "low-balance", actor: "system" });
    const short = await alice.post(`${W()}/apps/${appId}/autopilot/auto`);
    expect(short.status).toBe(402);
    expect(short.body.error.details.plan).toMatchObject({ fits: false, shortfall: { kind: "credits" }, smaller: { variants: 1 } });
    expect(short.body.error.userMessage).toMatch(/smaller run/);
    const smaller = await alice.post(`${W()}/apps/${appId}/autopilot/auto`, { variants: 1 });
    expect(smaller.status).toBe(202);
    expect(smaller.body.autopilot.budget.variants).toBe(1);
    await alice.post(`${W()}/autopilots/${smaller.body.autopilot.id}/cancel`);
    await p.credits.grant(wsA, 1000, { reason: "test top-up", idempotencyKey: "top-up", actor: "system" });
  });

  it("spend beyond the budget shows up in Needs you and still needs billing.manage", async () => {
    const appId = (await seedApp(p, wsA, { name: "Tight budget" })).appId;
    const started = await alice.post(`${W()}/apps/${appId}/autopilot`, { goal: "Grow", maxCredits: 30, autoApproveCredits: 0, variants: 1 });
    expect(started.status).toBe(202);
    await p.inline!.drain();
    const items = (await alice.get(`${W()}/needs-you?appId=${appId}`)).body.items as J[];
    expect(items).toHaveLength(1);
    const spend = items[0];
    expect(spend).toMatchObject({ kind: "spend", action: "spend", autopilotId: started.body.autopilot.id, requiredCap: "billing.manage", canDecide: true, approve: { path: `/autopilots/${started.body.autopilot.id}/checkpoint/approve` } });
    expect(spend.credits).toBeGreaterThan(0);
    const asEddie = (await eddie.get(`${W()}/needs-you?appId=${appId}`)).body.items[0];
    expect(asEddie.canDecide).toBe(false);
    expect((await eddie.post(`${W()}${spend.approve.path}`, spend.approve.body)).status).toBe(403);
    expect((await alice.post(`${W()}${spend.approve.path}`, spend.approve.body)).status).toBe(202);
    await alice.post(`${W()}/autopilots/${started.body.autopilot.id}/cancel`);
  });

  it("is tenant-isolated", async () => {
    expect((await bob.get(`${W()}/needs-you`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/needs-you?appId=${autoAppId}`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/needs-you`)).body).toEqual({ items: [], count: 0 });
    expect((await bob.get(`/v1/workspaces/${wsB}/apps/${autoAppId}/autopilot/auto`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/apps/${autoAppId}/autopilot/auto`)).status).toBe(404);
    expect((await bob.patch(W(), { settings: { autopilot: { enabled: false } } })).status).toBe(404);
  });
});
