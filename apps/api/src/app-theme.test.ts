import { seedApp } from "@muselaunch/agents/testing";
import { createTestPlatform } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * The interface colour per app (App.theme): the icon's colour from App DNA by default, filled in at
 * read time for apps analysed before apps carried a theme; editors can pick another colour,
 * monochrome, or go back to the icon's colour. Viewers and other workspaces can't change it.
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
  return {
    get: (path: string) => res(app.request(path, { headers: auth })),
    post: (path: string, body?: unknown) => res(app.request(path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body ?? {}) })),
    patch: (path: string, body: unknown) => res(app.request(path, { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) })),
  };
}

describe("App colour (App.theme)", () => {
  const p = createTestPlatform({});
  const app = buildApp(p);
  const alice = client(app, "alice");
  const vic = client(app, "vic");
  const bob = client(app, "bob");
  let wsA = "";
  let appId = "";
  const A = () => `/v1/workspaces/${wsA}`;

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await bob.post("/v1/workspaces", { name: "Bob Studio" });
    appId = (await seedApp(p, wsA)).appId;
    const ws = p.db.ws(wsA);
    const profile = (await ws.collection("brandProfiles").list({ limit: 10 })).items.find((b) => b.appId === appId)!;
    await ws.collection("brandProfiles").update(profile.id, { visual: { ...profile.visual, palette: [{ hex: "#0F0F10", role: "primary" }, { hex: "#E4405F", role: "secondary" }, { hex: "#ffffff", role: "background" }] } }, { actor: "alice" });
    await ws.collection("apps").update(appId, { brandProfileId: profile.id }, { actor: "alice" });
    await ws.collection("members").create({ id: "vic", userId: "vic", email: "vic@example.com", role: "viewer", canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
  });

  it("older apps get their icon's colour at read time (list and single), skipping grey icon colours", async () => {
    const list = (await vic.get(`${A()}/apps`)).body.items.find((a: J) => a.id === appId);
    expect(list.theme).toEqual({ color: "#e4405f", source: "icon" });
    expect((await vic.get(`${A()}/apps/${appId}`)).body.app.theme).toEqual({ color: "#e4405f", source: "icon" });
    // Read-time only: nothing was written.
    expect((await p.db.ws(wsA).collection("apps").get(appId))?.theme).toBeUndefined();
  });

  it("editors pick a colour, monochrome, or the icon's colour again; viewers and other workspaces can't", async () => {
    expect((await vic.patch(`${A()}/apps/${appId}`, { theme: { color: "#3355FF" } })).status).toBe(403);
    expect((await bob.patch(`${A()}/apps/${appId}`, { theme: { color: "#3355FF" } })).status).toBe(404);
    expect((await alice.patch(`${A()}/apps/${appId}`, { theme: { color: "blue" } })).status).toBe(422);

    const custom = await alice.patch(`${A()}/apps/${appId}`, { theme: { color: "#3355FF" } });
    expect(custom.status).toBe(200);
    expect(custom.body.app.theme).toEqual({ color: "#3355ff", source: "custom" });
    expect((await vic.get(`${A()}/apps`)).body.items.find((a: J) => a.id === appId).theme.color).toBe("#3355ff");

    expect((await alice.patch(`${A()}/apps/${appId}`, { theme: { color: null } })).body.app.theme).toEqual({ color: null, source: "custom" });
    expect((await alice.patch(`${A()}/apps/${appId}`, { theme: "icon" })).body.app.theme).toEqual({ color: "#e4405f", source: "icon" });
    // Other fields in the same PATCH still apply.
    const both = await alice.patch(`${A()}/apps/${appId}`, { name: "Tidy Timer 2", theme: { color: "#22c55e" } });
    expect(both.body.app).toMatchObject({ name: "Tidy Timer 2", theme: { color: "#22c55e", source: "custom" } });
  });
});
