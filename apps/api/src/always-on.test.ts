import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { seedApp } from "@muselaunch/agents/testing";
import { ALWAYS_ON_ACTOR } from "@muselaunch/autopilot";
import { AlwaysOnStatus, NeedsYouResponse } from "@muselaunch/contracts";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { localCrons } from "./local-cron";

/**
 * "Always on" over HTTP: the pace is checked against the plan server-side; changing the setting needs
 * the same capability as starting Autopilot (content.write); Always on's own Needs-you decisions need
 * the Autopilot checkpoint approver capability (content.approve); other workspaces see nothing.
 */

// biome-ignore lint: loose JSON in tests
type J = any;

function client(app: ReturnType<typeof buildApp>, uid: string) {
  const auth = { authorization: `Bearer dev:${uid}:${uid}@example.com` };
  const res = async (r: Response | Promise<Response>) => {
    const x = await r;
    const text = await x.text();
    return { status: x.status, body: (text ? JSON.parse(text) : null) as J };
  };
  const send = (method: string, path: string, body?: unknown) => res(app.request(path, { method, headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { get: (path: string) => res(app.request(path, { headers: auth })), post: (path: string, body?: unknown) => send("POST", path, body ?? {}), put: (path: string, body: unknown) => send("PUT", path, body) };
}

describe("Always on API (routes/always-on.ts)", () => {
  // No handlers: work that would start stays queued (this suite checks the HTTP contract only).
  const p = createTestPlatform({});
  const app = buildApp(p);
  const alice = client(app, "alice"); // owner
  const eddie = client(app, "eddie"); // editor
  const vic = client(app, "vic"); // viewer
  const bob = client(app, "bob"); // another workspace
  let wsA = "";
  let appId = "";
  const A = () => `/v1/workspaces/${wsA}`;
  const ws = () => p.db.ws(wsA);

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await bob.post("/v1/workspaces", { name: "Bob Studio" });
    appId = (await seedApp(p, wsA)).appId;
    for (const [uid, role] of [
      ["eddie", "editor"],
      ["vic", "viewer"],
    ] as const)
      await ws().collection("members").create({ id: uid, userId: uid, email: `${uid}@example.com`, role, canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
  });

  it("every member reads the status: the Free plan's pace options, with the plan that allows the rest", async () => {
    const r = await vic.get(`${A()}/apps/${appId}/always-on`);
    expect(r.status).toBe(200);
    const s = AlwaysOnStatus.parse(r.body);
    expect(s.settings).toMatchObject({ enabled: false, postsPerWeek: 1, emailSummary: false });
    expect(s.plan).toMatchObject({ id: "free", postsPerWeek: 1, monthlyCredits: 300 });
    expect(s.options.map((o) => [o.label, o.allowed, o.minPlan?.name ?? null])).toEqual([
      ["Once a week", true, null],
      ["3 times a week", false, "Starter"],
      ["5 times a week", false, "Growth"],
      ["Every day", false, "Studio"],
    ]);
    // Honest about the plan: once a week can use more credits a month than Free includes.
    expect(s.estimate.monthlyCredits).toBeGreaterThan(300);
    expect(s.estimate.fitsPlan).toBe(false);
    expect(s.gmail).toEqual({ connected: false });
    // Another workspace can't see it.
    expect((await bob.get(`${A()}/apps/${appId}/always-on`)).status).toBe(404);
  });

  it("changing it needs content.write; the pace is validated against the plan; the email needs Gmail", async () => {
    expect((await vic.put(`${A()}/apps/${appId}/always-on`, { enabled: true })).status).toBe(403);
    expect((await bob.put(`${A()}/apps/${appId}/always-on`, { enabled: true })).status).toBe(404);
    const tooFast = await alice.put(`${A()}/apps/${appId}/always-on`, { enabled: true, postsPerWeek: 3 });
    expect(tooFast.status).toBe(400);
    expect(tooFast.body.error.userMessage).toBe("Your Free beta plan allows up to 1 post a week. 3 times a week needs the Starter plan or higher.");
    expect((await alice.put(`${A()}/apps/${appId}/always-on`, { enabled: true, postsPerWeek: 2 })).status).toBe(422); // not an offered pace
    expect((await alice.put(`${A()}/apps/${appId}/always-on`, {})).status).toBe(422); // nothing to change
    const noGmail = await eddie.put(`${A()}/apps/${appId}/always-on`, { emailSummary: true });
    expect(noGmail.status).toBe(409);
    expect(noGmail.body.error.userMessage).toMatch(/Connect Gmail in Settings → Integrations first/);
    // An editor turns it on (same as starting Autopilot): a run starts within the credits.
    const on = await eddie.put(`${A()}/apps/${appId}/always-on`, { enabled: true, postsPerWeek: 1 });
    expect(on.status).toBe(200);
    expect(on.body.status.settings).toMatchObject({ enabled: true, postsPerWeek: 1, updatedBy: "eddie" });
    expect(on.body.start).toMatchObject({ started: true });
    const loop = await ws().collection("autopilots").getOrThrow(on.body.start.autopilotId);
    expect(loop.alwaysOn?.since).toBeTruthy();
    expect(loop.budget.variants).toBe(1);
    // It can't be set through the app's own PATCH.
    const patched = await app.request(`${A()}/apps/${appId}`, { method: "PATCH", headers: { authorization: "Bearer dev:alice:alice@example.com", "content-type": "application/json" }, body: JSON.stringify({ alwaysOn: { enabled: false } }) });
    expect([200, 422]).toContain(patched.status);
    expect((await ws().collection("apps").getOrThrow(appId)).alwaysOn?.enabled).toBe(true);
  });

  it("Always on's decisions refuse editors and viewers (content.approve); owners decide", async () => {
    const opp = await ws().collection("opportunities").create(
      { appId, title: "Exam-season study timers", topic: "Exam season", audience: "Students", whyRelevant: "Exams start next week.", proposedAngle: "A 25-minute session in 15 seconds", confidence: 0.8, evidence: [{ kind: "search_result", url: "https://news.example.com/exams", retrievedAt: new Date().toISOString() }], contentType: "short_video", effort: "low", observedAt: new Date().toISOString(), score: 80 },
      { actor: "agent:run1" },
    );
    const suggestion = await ws().collection("approvals").create(
      { appId, action: "agent_continue", subject: { entity: "opportunities", id: opp.id }, snapshotHash: "h1", summary: "This week’s research found “Exam-season study timers”: make a video about it?\nExams start next week. Sources: news.example.com.", requestedBy: ALWAYS_ON_ACTOR, status: "pending", estimate: { credits: 102 } },
      { actor: ALWAYS_ON_ACTOR },
    );
    const items = async (c: ReturnType<typeof client>) => NeedsYouResponse.parse((await c.get(`${A()}/needs-you?appId=${appId}`)).body).items;
    const mine = (await items(alice)).find((i) => i.id === suggestion.id)!;
    expect(mine).toMatchObject({ kind: "suggestion", canDecide: true, title: "This week’s research found “Exam-season study timers”: make a video about it?", summary: "Exams start next week. Sources: news.example.com.", labels: { approve: "Make a video", reject: "Not now" } });
    expect((await items(eddie)).find((i) => i.id === suggestion.id)?.canDecide).toBe(false);
    for (const c of [eddie, vic]) {
      expect((await c.post(`${A()}${mine.approve!.path}`)).status).toBe(403);
      expect((await c.post(`${A()}${mine.reject!.path}`)).status).toBe(403);
      expect((await c.post(`${A()}/apps/${appId}/always-on/pace/approve`)).status).toBe(403);
    }
    expect((await bob.post(`${A()}${mine.reject!.path}`)).status).toBe(404);
    // The owner turns it down: recorded on the approval, the opportunity is dismissed in Discover.
    const no = await alice.post(`${A()}${mine.reject!.path}`, { note: "Not for us" });
    expect(no.status).toBe(200);
    expect(no.body.approval).toMatchObject({ status: "rejected", decidedBy: "alice", note: "Not for us" });
    expect((await ws().collection("opportunities").getOrThrow(opp.id)).status).toBe("dismissed");
    expect((await alice.post(`${A()}${mine.approve!.path}`)).status).toBe(409);
    // No pace decision is waiting.
    expect((await alice.post(`${A()}/apps/${appId}/always-on/pace/reject`)).status).toBe(409);
  });

  it("turning it off withdraws Always on's open suggestions", async () => {
    const pending = await ws().collection("approvals").create(
      { appId, action: "agent_continue", subject: { entity: "researchFindings", id: "fnd_x" }, snapshotHash: "h2", summary: "People are talking about “X” this week: make a video about it?\nBody", requestedBy: ALWAYS_ON_ACTOR, status: "pending" },
      { actor: ALWAYS_ON_ACTOR },
    );
    const off = await alice.put(`${A()}/apps/${appId}/always-on`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.body.status.settings.enabled).toBe(false);
    expect((await ws().collection("approvals").getOrThrow(pending.id)).status).toBe("expired");
    expect(NeedsYouResponse.parse((await alice.get(`${A()}/needs-you?appId=${appId}`)).body).items.filter((i) => i.kind === "suggestion")).toEqual([]);
  });
});

describe("Always on cron wiring", () => {
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("runs in single-process mode next to publish-due and autopilot-wake", () => {
    expect(Object.keys(localCrons(createTestPlatform({})))).toEqual(["publish-due", "autopilot-wake", "always-on"]);
  });

  it("the worker serves it at /tasks/cron/always-on, and deploy schedules it in Cloud Scheduler", () => {
    const worker = read("../../worker/src/server.ts");
    expect(worker).toMatch(/"always-on": \(\) => runAlwaysOn\(platform\)/);
    expect(worker).toMatch(/runAlwaysOn, wakeDueAutopilots \} = await import\("@muselaunch\/autopilot"\)/);
    const deploy = read("../../../scripts/deploy.ts");
    expect(deploy).toMatch(/\["publish-due", "\* \* \* \* \*"\],\s*\["autopilot-wake", "\*\/5 \* \* \* \*"\],\s*\["always-on", "17 \* \* \* \*"\],/);
  });
});
