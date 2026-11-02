import { seedApp } from "@muselaunch/agents/testing";
import { App } from "@muselaunch/contracts";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * The first-run quick setup's answers over HTTP (routes/app-setup.ts): "Where do you post?" and
 * finishing/dismissing the quick setup. Both need content.write (like Always on); other workspaces
 * see nothing; nothing here connects an account or posts.
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

describe("Quick setup API (routes/app-setup.ts)", () => {
  const p = createTestPlatform({});
  const app = buildApp(p);
  const alice = client(app, "alice"); // owner
  const eddie = client(app, "eddie"); // editor
  const vic = client(app, "vic"); // viewer
  const bob = client(app, "bob"); // another workspace
  let wsA = "";
  let appId = "";
  const A = () => `/v1/workspaces/${wsA}`;

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await bob.post("/v1/workspaces", { name: "Bob Studio" });
    appId = (await seedApp(p, wsA)).appId;
    for (const [uid, role] of [
      ["eddie", "editor"],
      ["vic", "viewer"],
    ] as const)
      await p.db.ws(wsA).collection("members").create({ id: uid, userId: uid, email: `${uid}@example.com`, role, canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
  });

  it("“Where do you post?” is saved per app (de-duplicated, in order); content.write only; other workspaces can't", async () => {
    expect(App.parse((await vic.get(`${A()}/apps/${appId}`)).body.app).postTo).toBeUndefined();
    expect((await vic.put(`${A()}/apps/${appId}/post-to`, { channels: ["instagram"] })).status).toBe(403);
    expect((await bob.put(`${A()}/apps/${appId}/post-to`, { channels: ["instagram"] })).status).toBe(404);
    expect((await eddie.put(`${A()}/apps/${appId}/post-to`, { channels: ["reddit"] })).status).toBe(422);
    const r = await eddie.put(`${A()}/apps/${appId}/post-to`, { channels: ["tiktok", "instagram", "tiktok"] });
    expect(r.status).toBe(200);
    expect(r.body.app.postTo).toMatchObject({ channels: ["tiktok", "instagram"], manual: false, updatedBy: "eddie" });
    // The app list (what the web reads) carries it.
    expect((await vic.get(`${A()}/apps`)).body.items.find((a: J) => a.id === appId).postTo.channels).toEqual(["tiktok", "instagram"]);
    // "I'll post myself" is its own answer: the platforms are cleared.
    const manual = await alice.put(`${A()}/apps/${appId}/post-to`, { channels: ["youtube"], manual: true });
    expect(manual.body.app.postTo).toMatchObject({ channels: [], manual: true });
    const audit = (await p.db.ws(wsA).collection("auditLog").list({ limit: 100 })).items.filter((a) => a.action === "app.post_to_updated");
    expect(audit).toHaveLength(2);
  });

  it("the quick setup is finished or dismissed once, and the first answer sticks", async () => {
    expect((await vic.put(`${A()}/apps/${appId}/quick-setup`, { status: "dismissed" })).status).toBe(403);
    expect((await bob.put(`${A()}/apps/${appId}/quick-setup`, { status: "dismissed" })).status).toBe(404);
    expect((await eddie.put(`${A()}/apps/${appId}/quick-setup`, { status: "later" })).status).toBe(422);
    const r = await eddie.put(`${A()}/apps/${appId}/quick-setup`, { status: "dismissed" });
    expect(r.status).toBe(200);
    expect(r.body.app.quickSetup).toMatchObject({ status: "dismissed", by: "eddie" });
    const again = await alice.put(`${A()}/apps/${appId}/quick-setup`, { status: "done" });
    expect(again.body.app.quickSetup.status).toBe("dismissed");
  });

  it("nothing here connects or posts: no accounts, posts or approvals were created", async () => {
    const ws = p.db.ws(wsA);
    expect((await ws.collection("connectedAccounts").list({ limit: 10 })).items).toEqual([]);
    expect((await ws.collection("scheduledPosts").list({ limit: 10 })).items).toEqual([]);
    expect((await ws.collection("approvals").list({ limit: 10 })).items).toEqual([]);
  });
});
