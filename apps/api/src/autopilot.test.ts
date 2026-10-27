import { seedApp } from "@muselaunch/agents/testing";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

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

describe("Growth Autopilot API (routes/autopilot.ts)", () => {
  const h = autopilotPlatform();
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");
  const eddie = client(app, "eddie", "eddie@example.com");
  const carol = client(app, "carol", "carol@example.com");
  let wsA = "";
  let wsB = "";
  let appId = "";
  let app2 = "";
  const W = () => `/v1/workspaces/${wsA}`;

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).body.workspace.id;
    await p.db.top("workspaces").update(wsA, { planId: "studio" }); // room for the extra members
    await p.credits.grant(wsA, 1000, { reason: "test", idempotencyKey: "autopilot-test", actor: "system" });
    appId = (await seedApp(p, wsA)).appId;
    app2 = (await seedApp(p, wsA, { name: "Second app" })).appId;
    for (const [who, role] of [
      [eddie, "editor"],
      [carol, "viewer"],
    ] as const) {
      const inv = await alice.post(`${W()}/invites`, { email: who === eddie ? "eddie@example.com" : "carol@example.com", role });
      expect((await who.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
    }
  });

  it("estimates, starts (202), runs to the measure window and exposes the loop for the UI", async () => {
    const est = await alice.get(`${W()}/apps/${appId}/autopilot/estimate?variants=2`);
    expect(est.body.perIteration).toBeGreaterThan(50);
    expect(est.body.breakdown.length).toBeGreaterThan(4);
    const started = await alice.post(`${W()}/apps/${appId}/autopilot`, { goal: "More student installs before exams", maxCredits: 400, autoApproveCredits: 100, variants: 2 });
    expect(started.status).toBe(202);
    expect(started.body.job.type).toBe("autopilot.step");
    await p.inline!.drain();
    const id = started.body.autopilot.id;
    const detail = await alice.get(`${W()}/autopilots/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.autopilot).toMatchObject({ status: "sleeping", stage: "measure" });
    expect(detail.body.waitingFor).toMatch(/^Waiting for results until/);
    expect(detail.body.runs).toHaveLength(3);
    expect(detail.body.reviews).toHaveLength(2);
    expect(detail.body.jobs.length).toBeGreaterThan(8);
    const list = await alice.get(`${W()}/apps/${appId}/autopilots`);
    expect(list.body.items[0]).toMatchObject({ id, status: "sleeping" });
    expect(list.body.items[0].log).toBeUndefined();
    // One active loop per app
    expect((await alice.post(`${W()}/apps/${appId}/autopilot`, { goal: "again" })).status).toBe(409);
    expect((await alice.post(`${W()}/autopilots/${id}/cancel`)).body.autopilot.status).toBe("cancelled");
  });

  it("checkpoints need the approver capability: editors can start (no auto-approve) but can't approve spend", async () => {
    // Editors may not pre-authorise spend.
    expect((await eddie.post(`${W()}/apps/${app2}/autopilot`, { goal: "Grow", maxCredits: 50, autoApproveCredits: 20 })).status).toBe(403);
    const started = await eddie.post(`${W()}/apps/${app2}/autopilot`, { goal: "Grow", maxCredits: 50, autoApproveCredits: 0, variants: 2 });
    expect(started.status).toBe(202);
    await p.inline!.drain();
    const id = started.body.autopilot.id;
    let detail = await eddie.get(`${W()}/autopilots/${id}`);
    expect(detail.body.autopilot.status).toBe("awaiting_user");
    expect(detail.body.checkpoint).toMatchObject({ action: "spend", status: "pending" });
    expect((await eddie.post(`${W()}/autopilots/${id}/checkpoint`, { decision: "approve" })).status).toBe(403);
    expect((await eddie.post(`${W()}/autopilots/${id}/checkpoint`, { decision: "reject" })).status).toBe(403);
    expect((await eddie.post(`${W()}/autopilots/${id}/checkpoint/approve`)).status).toBe(403);
    expect((await carol.post(`${W()}/autopilots/${id}/pause`)).status).toBe(403);
    const ok = await alice.post(`${W()}/autopilots/${id}/checkpoint/approve`, { note: "go" });
    expect(ok.status).toBe(202);
    await p.inline!.drain();
    detail = await alice.get(`${W()}/autopilots/${id}`);
    expect(detail.body.autopilot.log.some((e: J) => e.kind === "checkpoint" && e.summary.startsWith("You approved"))).toBe(true);
    // Pause / resume / cancel lifecycle (editor may pause and resume)
    const paused = await eddie.post(`${W()}/autopilots/${id}/pause`);
    expect(paused.body.autopilot.status).toBe("paused");
    expect((await eddie.post(`${W()}/autopilots/${id}/resume`)).status).toBe(202);
    await p.inline!.drain();
    expect((await alice.post(`${W()}/autopilots/${id}/cancel`)).body.autopilot.status).toBe("cancelled");
    expect((await alice.post(`${W()}/autopilots/${id}/checkpoint`, { decision: "approve" })).status).toBe(409);
  });

  it("is tenant-isolated", async () => {
    const list = await alice.get(`${W()}/apps/${appId}/autopilots`);
    const id = list.body.items[0].id;
    expect((await bob.get(`${W()}/autopilots/${id}`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsB}/autopilots/${id}`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/autopilots/${id}/resume`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsB}/apps/${appId}/autopilot`, { goal: "steal" })).status).toBe(404);
  });
});
