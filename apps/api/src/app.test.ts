import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { buildApp } from "./app";

function client(app: ReturnType<typeof buildApp>, uid: string, email = `${uid}@example.com`) {
  const auth = { authorization: `Bearer dev:${uid}:${email}` };
  return {
    get: (path: string) => app.request(path, { headers: auth }),
    post: (path: string, body?: unknown) => app.request(path, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    patch: (path: string, body: unknown) => app.request(path, { method: "PATCH", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) }),
  };
}

describe("API", () => {
  const p = createTestPlatform({}, { "app.import": async () => ({ data: { stub: true } }), "media.probe": async () => ({}) });
  const app = buildApp(p);
  const alice = client(app, "alice");
  const bob = client(app, "bob");

  it("rejects unauthenticated requests", async () => {
    const res = await app.request("/v1/me");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHENTICATED");
  });

  let wsA = "";
  let wsB = "";
  it("creates workspaces with signup credits", async () => {
    const res = await alice.post("/v1/workspaces", { name: "Alice Apps" });
    expect(res.status).toBe(201);
    wsA = (await res.json()).workspace.id;
    wsB = (await (await bob.post("/v1/workspaces", { name: "Bob Studio" })).json()).workspace.id;
    const me = await (await alice.get("/v1/me")).json();
    expect(me.workspaces.map((w: { workspace: { id: string } }) => w.workspace.id)).toEqual([wsA]);
    const credits = await (await alice.get(`/v1/workspaces/${wsA}/billing/credits`)).json();
    expect(credits.balance.available).toBe(300);
  });

  it("isolates tenants: non-members get 404", async () => {
    expect((await bob.get(`/v1/workspaces/${wsA}`)).status).toBe(404);
    expect((await bob.get(`/v1/workspaces/${wsA}/apps`)).status).toBe(404);
    expect((await bob.post(`/v1/workspaces/${wsA}/apps`, { name: "x" })).status).toBe(404);
  });

  let appId = "";
  it("creates an app from a store URL and queues an import job with a credit hold", async () => {
    const res = await alice.post(`/v1/workspaces/${wsA}/apps`, { appStoreUrl: "https://apps.apple.com/us/app/example/id123456789" });
    expect(res.status).toBe(202);
    const { app: created, job } = await res.json();
    appId = created.id;
    expect(job.type).toBe("app.import");
    expect(job.reservation.credits).toBeGreaterThan(0);
    await p.inline!.drain();
    const done = await (await alice.get(`/v1/workspaces/${wsA}/jobs/${job.id}`)).json();
    expect(done.job.status).toBe("succeeded");
    // Bob cannot read Alice's job even with its id
    expect((await bob.get(`/v1/workspaces/${wsB}/jobs/${job.id}`)).status).toBe(404);
  });

  it("refuses unsafe import URLs", async () => {
    const res = await alice.post(`/v1/workspaces/${wsA}/apps`, { websiteUrl: "http://169.254.169.254/latest/meta-data" });
    expect(res.status).toBe(400);
  });

  it("invites a member with a role and enforces capabilities", async () => {
    const inv = await (await alice.post(`/v1/workspaces/${wsA}/invites`, { email: "carol@example.com", role: "viewer" })).json();
    const token = inv.acceptUrl.split("/").pop();
    const carol = client(app, "carol", "carol@example.com");
    expect((await client(app, "mallory", "mallory@example.com").post(`/v1/invites/${token}/accept`)).status).toBe(403);
    expect((await carol.post(`/v1/invites/${token}/accept`)).status).toBe(200);
    expect((await carol.get(`/v1/workspaces/${wsA}/apps`)).status).toBe(200);
    const denied = await carol.post(`/v1/workspaces/${wsA}/apps`, { name: "nope" });
    expect(denied.status).toBe(403);
  });

  it("signs uploads, accepts the PUT and serves a ranged download", async () => {
    const res = await alice.post(`/v1/workspaces/${wsA}/uploads`, { filename: "shot 1.png", mimeType: "image/png", bytes: 8, role: "screenshot", appId });
    expect(res.status).toBe(201);
    const { asset, upload } = await res.json();
    const path = new URL(upload.url).pathname;
    const put = await app.request(path, { method: "PUT", headers: { "content-type": "image/png" }, body: "PNGDATA!" });
    expect(put.status).toBe(200);
    const done = await (await alice.post(`/v1/workspaces/${wsA}/assets/${asset.id}/complete`)).json();
    expect(done.asset.status).toBe("uploaded");
    const { url } = await (await alice.get(`/v1/workspaces/${wsA}/assets/${asset.id}/url`)).json();
    const ranged = await app.request(new URL(url).pathname, { headers: { range: "bytes=0-2" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("PNG");
    // tampered token rejected
    expect((await app.request(new URL(url).pathname + "x")).status).toBe(403);
    // other tenant cannot mint a URL for it
    expect((await bob.get(`/v1/workspaces/${wsB}/assets/${asset.id}/url`)).status).toBe(404);
  });

  it("reports provider status honestly when keys are missing", async () => {
    const res = await (await alice.get("/v1/status/providers")).json();
    const wonder = res.items.find((i: { id: string }) => i.id === "muse-wonder");
    const museImage = res.items.find((i: { id: string }) => i.id === "muse-image");
    expect(wonder.state).toBe("not_configured");
    expect(museImage.state).toBe("restricted");
  });
});
