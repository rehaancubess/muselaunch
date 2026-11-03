import { seedApp } from "@muselaunch/agents/testing";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { DEVICE_LINK_ALPHABET, normalizeLinkCode } from "@muselaunch/contracts";
import { MemoryDb } from "@muselaunch/db";
import {
  checkPushReceipts,
  createTestPlatform,
  deviceSecretHash,
  notifyPostLive,
  notifyPostsReady,
  notifyWeeklySummary,
  sendPushToUsers,
  setPushFetch,
  type PushFetch,
} from "@muselaunch/platform";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildApp } from "./app";

/**
 * The phone app's way in (routes/devices.ts) and its push notifications (platform/push.ts).
 *
 * Linking: a web session makes an 8-character code (10 minutes, single use, only its hash stored);
 * the phone redeems it for a long random `mld_` token (only its hash stored, 90 days) that the API
 * accepts as that person. Wrong, used and expired codes look the same; tries are rate-limited per
 * address and code-making per person; removed and expired tokens are refused; a phone can't make
 * more links, accept invites, reach the operator console or remove other phones.
 *
 * Pushes: only to linked phones with notifications on, "posts ready to review" at most once per
 * app per hour (one push for Autopilot's whole batch), and tokens Expo calls DeviceNotRegistered
 * are removed (from tickets and from receipts).
 */

// biome-ignore lint: loose JSON in tests
type J = any;

type App = ReturnType<typeof buildApp>;

function client(app: App, auth: string | null, extra: Record<string, string> = {}) {
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json", ...extra, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as J, text, headers: res.headers };
  };
  return {
    get: (path: string) => send("GET", path),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => send("POST", path, body ?? {}, headers),
    put: (path: string, body?: unknown) => send("PUT", path, body ?? {}),
    del: (path: string) => send("DELETE", path),
  };
}

const dev = (uid: string) => `dev:${uid}:${uid}@example.com`;
let ipSeq = 0;
/** A fresh client address per test, so the per-address limit only bites where it's tested. */
const freshIp = () => `203.0.113.${++ipSeq}`;

async function link(app: App, webToken: string, opts: { name?: string; platform?: "ios" | "android" | "web" } = {}) {
  const web = client(app, webToken);
  const made = await web.post("/v1/me/device-links");
  expect(made.status).toBe(201);
  const phone = client(app, null, { "x-forwarded-for": freshIp() });
  const redeemed = await phone.post("/v1/device-links/redeem", { code: made.body.code, deviceName: opts.name ?? "Rehaan’s iPhone", platform: opts.platform ?? "ios", appVersion: "1.0.0" });
  expect(redeemed.status, redeemed.text).toBe(201);
  return { code: made.body.code as string, token: redeemed.body.token as string, deviceId: redeemed.body.device.id as string, body: redeemed.body };
}

/** Every stored document, as text (to check no secret is ever stored in the clear). */
function storedText(db: MemoryDb): string {
  const out: unknown[] = [];
  for (const name of ["devices", "deviceLinks", "users", "ops"]) out.push(db.listRaw(name));
  return JSON.stringify(out);
}

describe("Linking a phone from the web", () => {
  const p = createTestPlatform();
  const app = buildApp(p);
  const alice = client(app, dev("alice"));
  const bob = client(app, dev("bob"));
  let wsA = "";
  let wsB = "";

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).body.workspace.id;
  });

  it("makes an 8-character code from the unambiguous alphabet, valid 10 minutes, with the QR text", async () => {
    const before = Date.now();
    const r = await alice.post("/v1/me/device-links");
    expect(r.status).toBe(201);
    expect(r.body.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const plain = normalizeLinkCode(r.body.code)!;
    for (const ch of plain) expect(DEVICE_LINK_ALPHABET).toContain(ch);
    expect(Date.parse(r.body.expiresAt) - before).toBeGreaterThan(9.9 * 60_000);
    expect(Date.parse(r.body.expiresAt) - before).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect(r.body.qr).toBe(`muselaunch://link?code=${plain}&api=${encodeURIComponent(p.cfg.API_PUBLIC_URL)}`);
    // Only the hash is stored, as the document id.
    expect(await p.db.top("deviceLinks").get(deviceSecretHash("code", plain))).toBeTruthy();
    expect(storedText(p.db)).not.toContain(plain);
  });

  it("redeems the code (typed with spaces, lower case) for a phone token that works as that person", async () => {
    const made = await alice.post("/v1/me/device-links");
    const typed = normalizeLinkCode(made.body.code)!.toLowerCase().replace(/(.{4})/, "$1 ");
    const phone = client(app, null, { "x-forwarded-for": freshIp() });
    const r = await phone.post("/v1/device-links/redeem", { code: typed, deviceName: "Pixel 9", platform: "android" });
    expect(r.status, r.text).toBe(201);
    expect(r.body.token).toMatch(/^mld_[A-Za-z0-9_-]{43}$/);
    expect(r.body.device).toMatchObject({ name: "Pixel 9", platform: "android", current: true, notifications: { enabled: true, registered: false } });
    expect(r.body.device).not.toHaveProperty("tokenHash");
    expect(r.body.user.id).toBe("alice");
    // 90 days.
    expect(Date.parse(r.body.device.expiresAt) - Date.now()).toBeGreaterThan(89 * 86_400_000);

    const me = await client(app, r.body.token).get("/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.user.id).toBe("alice");
    expect(me.body.workspaces.map((w: J) => w.workspace.id)).toEqual([wsA]);
    // Tenant-scoped routes too, and still not someone else's workspace.
    expect((await client(app, r.body.token).get(`/v1/workspaces/${wsA}/apps`)).status).toBe(200);
    expect((await client(app, r.body.token).get(`/v1/workspaces/${wsB}/apps`)).status).toBe(404);
    // The token itself is never stored; its hash is the device's document id.
    expect(storedText(p.db)).not.toContain(r.body.token);
    expect(storedText(p.db)).not.toContain(r.body.token.slice(4));
    expect(await p.db.top("devices").get(deviceSecretHash("token", r.body.token))).toMatchObject({ userId: "alice", name: "Pixel 9" });
  });

  it("works once: a used code, an expired code, a wrong code and a malformed one all get the same answer", async () => {
    const { code } = await link(app, dev("alice"));
    const phone = client(app, null, { "x-forwarded-for": freshIp() });
    const again = await phone.post("/v1/device-links/redeem", { code, deviceName: "Second phone", platform: "ios" });
    expect(again.status).toBe(400);

    const made = await alice.post("/v1/me/device-links");
    const id = deviceSecretHash("code", normalizeLinkCode(made.body.code)!);
    const stored = (await p.db.top("deviceLinks").get(id))!;
    await p.db.top("deviceLinks").set(id, { ...stored, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const expired = await phone.post("/v1/device-links/redeem", { code: made.body.code, deviceName: "Late phone", platform: "ios" });
    expect(expired.status).toBe(400);

    const wrong = await phone.post("/v1/device-links/redeem", { code: "AAAA-BBBB", deviceName: "Guess", platform: "ios" });
    const malformed = await phone.post("/v1/device-links/redeem", { code: "OOOO-1111", deviceName: "Guess", platform: "ios" });
    for (const r of [again, expired, wrong, malformed]) {
      expect(r.status).toBe(400);
      expect(r.body.error.userMessage).toBe(again.body.error.userMessage);
      expect(r.body).not.toHaveProperty("token");
    }
  });

  it("a new code replaces the person's unused one", async () => {
    const nina = client(app, dev("nina"));
    const first = await nina.post("/v1/me/device-links");
    const second = await nina.post("/v1/me/device-links");
    const phone = client(app, null, { "x-forwarded-for": freshIp() });
    expect((await phone.post("/v1/device-links/redeem", { code: first.body.code, deviceName: "Old code", platform: "ios" })).status).toBe(400);
    expect((await phone.post("/v1/device-links/redeem", { code: second.body.code, deviceName: "New code", platform: "ios" })).status).toBe(201);
  });

  it("limits redeem tries per address (10 per 10 minutes) without blocking other addresses", async () => {
    const attacker = client(app, null, { "x-forwarded-for": "198.51.100.7" });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await attacker.post("/v1/device-links/redeem", { code: "ZZZZ-ZZZZ", deviceName: "Guess", platform: "ios" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    // Spoofing an earlier X-Forwarded-For entry doesn't reset it: the last one (added by Cloud Run) counts.
    const spoofed = client(app, null, { "x-forwarded-for": "10.0.0.1, 198.51.100.7" });
    const r = await spoofed.post("/v1/device-links/redeem", { code: "ZZZZ-ZZZZ", deviceName: "Guess", platform: "ios" });
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("600");
    // A real link from another address still works.
    await link(app, dev("uma"));
  });

  it("limits code-making per person (5 per 10 minutes)", async () => {
    const carl = client(app, dev("carl"));
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await carl.post("/v1/me/device-links")).status);
    expect(statuses).toEqual([201, 201, 201, 201, 201, 429]);
  });

  it("refuses unknown, malformed, removed and expired phone tokens", async () => {
    const shaped = `mld_${"A".repeat(43)}`;
    for (const t of [shaped, "mld_short", `mld_${"!".repeat(43)}`]) {
      const r = await client(app, t).get("/v1/me");
      expect(r.status, t).toBe(401);
    }
    const rita = client(app, dev("rita"));
    const { token, deviceId } = await link(app, dev("rita"), { name: "Removed later" });
    expect((await client(app, token).get("/v1/me")).status).toBe(200);
    // Removed from the web (Settings → Phone app → Remove).
    const listed = await rita.get("/v1/me/devices");
    expect(listed.body.items.find((d: J) => d.id === deviceId)).toMatchObject({ name: "Removed later", current: false });
    expect((await rita.del(`/v1/me/devices/${deviceId}`)).status).toBe(200);
    expect((await client(app, token).get("/v1/me")).status).toBe(401);
    expect((await rita.get("/v1/me/devices")).body.items.some((d: J) => d.id === deviceId)).toBe(false);

    const old = await link(app, dev("rita"), { name: "Expired" });
    const hash = deviceSecretHash("token", old.token);
    const d = (await p.db.top("devices").get(hash))!;
    await p.db.top("devices").set(hash, { ...d, expiresAt: new Date(Date.now() - 1000).toISOString() });
    const r = await client(app, old.token).get("/v1/me");
    expect(r.status).toBe(401);
    expect(await p.db.top("devices").get(hash)).toBeNull();
  });

  it("a phone can't make more links, accept invites, open the operator console or remove other phones", async () => {
    const a = await link(app, dev("paul"), { name: "Phone A" });
    const b = await link(app, dev("paul"), { name: "Phone B" });
    const phoneA = client(app, a.token);
    expect((await phoneA.post("/v1/me/device-links")).status).toBe(403);
    const inv = await alice.post(`/v1/workspaces/${wsA}/invites`, { email: "dora@example.com", role: "editor" });
    expect(inv.status).toBe(201);
    expect((await phoneA.post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(403);
    expect((await phoneA.get("/v1/admin/ops")).status).toBe(403);
    expect((await phoneA.del(`/v1/me/devices/${b.deviceId}`)).status).toBe(403);
    // It sees which phone it is, and can unlink itself.
    const listed = await phoneA.get("/v1/me/devices");
    expect(listed.body.items.find((d: J) => d.id === a.deviceId).current).toBe(true);
    expect((await phoneA.get("/v1/me/device")).body.device).toMatchObject({ id: a.deviceId, name: "Phone A", current: true });
    expect((await phoneA.del("/v1/me/device")).status).toBe(200);
    expect((await phoneA.get("/v1/me")).status).toBe(401);
    expect((await client(app, b.token).get("/v1/me")).status).toBe(200);
  });

  it("someone else can't see or remove your phones", async () => {
    const a = await link(app, dev("sara"), { name: "Alice private phone" });
    expect(JSON.stringify((await bob.get("/v1/me/devices")).body)).not.toContain("Alice private phone");
    expect((await bob.del(`/v1/me/devices/${a.deviceId}`)).status).toBe(404);
    expect((await client(app, a.token).get("/v1/me")).status).toBe(200);
  });

  it("the phone registers its push token and switch; the same phone linked again only keeps the newest link", async () => {
    const a = await link(app, dev("tom"), { name: "Push phone" });
    const phone = client(app, a.token);
    const token = "ExponentPushToken[abcdefghijklmnop1234]";
    expect((await phone.put("/v1/me/device/push", { token: "not-a-token" })).status).toBe(422);
    expect((await client(app, dev("tom")).put("/v1/me/device/push", { token })).status).toBe(403);
    const r = await phone.put("/v1/me/device/push", { token });
    expect(r.status).toBe(200);
    expect(r.body.device.notifications).toEqual({ enabled: true, registered: true });
    const off = await phone.put("/v1/me/device/push", { enabled: false });
    expect(off.body.device.notifications).toEqual({ enabled: false, registered: true });
    // Re-linked (as Bob) on the same phone: Tom's old link stops getting this phone's pushes.
    const again = await link(app, dev("bob"), { name: "Same phone, Bob" });
    await client(app, again.token).put("/v1/me/device/push", { token });
    expect((await p.db.top("devices").get(deviceSecretHash("token", a.token)))!.push.token).toBeUndefined();
  });

  it("redeem is the only phone route without a token", async () => {
    for (const [method, path] of [
      ["POST", "/v1/me/device-links"],
      ["GET", "/v1/me/devices"],
      ["DELETE", "/v1/me/devices/x"],
      ["GET", "/v1/me/device"],
      ["DELETE", "/v1/me/device"],
      ["PUT", "/v1/me/device/push"],
    ] as const) {
      const r = await app.request(path, { method });
      expect(r.status, `${method} ${path}`).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

type Sent = { url: string; body: J };

let ticketSeq = 0;
/** Ticket ids Expo gave out, by push token (the newest last). */
const issued = new Map<string, string[]>();

function fakeExpo(opts: { ticket?: (to: string) => J; receipts?: Record<string, J> } = {}) {
  const sent: Sent[] = [];
  const f: PushFetch = async (url, init) => {
    const body = JSON.parse(init.body) as J;
    sent.push({ url, body });
    if (url.endsWith("/getReceipts")) return { ok: true, status: 200, json: async () => ({ data: opts.receipts ?? {} }) };
    const data = (body as J[]).map((m) => {
      const custom = opts.ticket?.(m.to);
      if (custom) return custom;
      const id = `tkt_${++ticketSeq}`;
      issued.set(m.to, [...(issued.get(m.to) ?? []), id]);
      return { status: "ok", id };
    });
    return { ok: true, status: 200, json: async () => ({ data }) };
  };
  setPushFetch(f);
  return sent;
}

describe("Push notifications to linked phones", () => {
  afterEach(() => setPushFetch(null));
  const p = createTestPlatform();
  const app = buildApp(p);
  const alice = client(app, dev("alice")); // owner (can publish)
  let wsA = "";
  let appId = "";
  const tokens = { alice: "ExponentPushToken[alicealicealice1]", alice2: "ExponentPushToken[alicesecondphone]", eddie: "ExponentPushToken[eddieeddieeddie1]" };

  const pending = async (n: number) => {
    for (let i = 0; i < n; i++) {
      await p.db.ws(wsA).collection("approvals").create(
        { appId, action: "publish", subject: { entity: "scheduledPosts", id: `pst_t${Date.now()}${i}` }, snapshotHash: "h", summary: "Publish", requestedBy: "alice", status: "pending", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
        { actor: "alice" },
      );
    }
  };

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    appId = (await seedApp(p, wsA, { name: "Tidy Timer" })).appId;
    // Eddie: an editor, who can't schedule posts.
    const inv = await alice.post(`/v1/workspaces/${wsA}/invites`, { email: "eddie@example.com", role: "editor" });
    expect((await client(app, dev("eddie")).post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
    const a1 = await link(app, dev("alice"), { name: "Alice iPhone" });
    const a2 = await link(app, dev("alice"), { name: "Alice iPad" });
    const e = await link(app, dev("eddie"), { name: "Eddie Pixel", platform: "android" });
    await client(app, a1.token).put("/v1/me/device/push", { token: tokens.alice });
    await client(app, a2.token).put("/v1/me/device/push", { token: tokens.alice2 });
    await client(app, e.token).put("/v1/me/device/push", { token: tokens.eddie });
    // A phone with notifications switched off, and one that never registered: never pushed.
    const off = await link(app, dev("alice"), { name: "Switched off" });
    await client(app, off.token).put("/v1/me/device/push", { token: "ExponentPushToken[switchedoffphone]", enabled: false });
    await link(app, dev("alice"), { name: "No token" });
  });

  it("“posts ready to review”: counts what waits now, goes to who can schedule, at most once per app per hour", async () => {
    const sent = fakeExpo();
    expect(await notifyPostsReady(p, wsA, appId)).toBeNull(); // nothing waiting: nothing sent
    expect(sent).toEqual([]);
    await pending(2);
    const now = Date.now();
    const r = await notifyPostsReady(p, wsA, appId, now);
    expect(r).toMatchObject({ devices: 2, sent: 2, removed: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe("https://exp.host/--/api/v2/push/send");
    const msgs = sent[0]!.body as J[];
    expect(msgs.map((m) => m.to).sort()).toEqual([tokens.alice, tokens.alice2].sort());
    expect(msgs[0]).toMatchObject({ title: "Tidy Timer", body: "2 posts are ready to review", sound: "default", data: { kind: "posts_ready", url: `/?w=${wsA}&a=${appId}`, workspaceId: wsA, appId } });
    // Within the hour: nothing more.
    await pending(1);
    expect(await notifyPostsReady(p, wsA, appId, now + 30 * 60_000)).toBeNull();
    expect(sent).toHaveLength(1);
    // After the hour: the current count.
    await notifyPostsReady(p, wsA, appId, now + 61 * 60_000);
    expect(sent).toHaveLength(2);
    expect((sent[1]!.body as J[])[0].body).toBe("3 posts are ready to review");
  });

  it("“post is live” and the weekly summary go to everyone with a linked phone and open Results", async () => {
    const sent = fakeExpo();
    await notifyPostLive(p, wsA, { appId, channel: "youtube", title: "Focus in 20 seconds" });
    const live = sent[0]!.body as J[];
    expect(live.map((m) => m.to).sort()).toEqual([tokens.alice, tokens.alice2, tokens.eddie].sort());
    expect(live[0]).toMatchObject({ body: "Your post is live on YouTube: “Focus in 20 seconds”. Results counts what it brings in.", data: { kind: "post_live", url: `/results?w=${wsA}&a=${appId}` } });
    await notifyWeeklySummary(p, wsA, appId, { posted: 3, queued: 2, needsYou: 1, findings: 0 });
    expect((sent[1]!.body as J[])[0]).toMatchObject({ title: "Your week: Tidy Timer", body: "3 posts went out · 2 lined up · 1 waiting for your OK.", data: { kind: "weekly_summary" } });
  });

  it("removes tokens Expo reports as DeviceNotRegistered, from tickets and from receipts", async () => {
    let sent = fakeExpo({ ticket: (to) => (to === tokens.alice2 ? { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } } : undefined) });
    const r = await sendPushToUsers(p, ["alice"], { kind: "post_live", title: "t", body: "b", url: "/", workspaceId: wsA });
    expect(r).toMatchObject({ devices: 2, sent: 1, removed: 1 });
    const devices = (await p.db.top("devices").list({ where: [["userId", "==", "alice"]], limit: 50 })).items;
    expect(devices.some((d) => d.push.token === tokens.alice2)).toBe(false);
    expect(devices.find((d) => d.name === "Alice iPad")?.push.enabled).toBe(true);

    // A later receipt says Eddie's app is gone.
    sent = fakeExpo();
    await sendPushToUsers(p, ["eddie"], { kind: "post_live", title: "t", body: "b", url: "/", workspaceId: wsA });
    const ticketId = issued.get(tokens.eddie)!.at(-1)!;
    // Every other ticket so far: delivered fine.
    const fine = Object.fromEntries([...issued.values()].flat().filter((id) => id !== ticketId).map((id) => [id, { status: "ok" }]));
    sent = fakeExpo({ receipts: { ...fine, [ticketId]: { status: "error", details: { error: "DeviceNotRegistered" } } } });
    expect(await checkPushReceipts(p, Date.now())).toEqual({ checked: 0, removed: 0 }); // too early: Expo's 15 minutes
    expect(sent).toEqual([]);
    expect(await checkPushReceipts(p, Date.now() + 16 * 60_000)).toMatchObject({ removed: 1 });
    expect(sent[0]!.url).toBe("https://exp.host/--/api/v2/push/getReceipts");
    // Checked receipts are done with; nothing is asked twice.
    sent.length = 0;
    expect(await checkPushReceipts(p, Date.now() + 17 * 60_000)).toEqual({ checked: 0, removed: 0 });
    expect(sent).toEqual([]);
    expect((await p.db.top("devices").list({ where: [["userId", "==", "eddie"]], limit: 5 })).items[0]!.push.token).toBeUndefined();
  });

  it("never fails the work that caused it when Expo can't be reached", async () => {
    setPushFetch(async () => {
      throw new Error("network down");
    });
    await pending(1);
    const r = await notifyPostLive(p, wsA, { appId, channel: "instagram" });
    expect(r).toMatchObject({ sent: 0, failed: 1 });
  });
});

describe("Autopilot's drafts send one push for the batch", () => {
  afterEach(() => setPushFetch(null));
  const h = autopilotPlatform();
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, dev("alice"));
  const kinds = (sent: Sent[]) => sent.filter((s) => s.url.endsWith("/send")).map((s) => (s.body as J[])[0]?.data?.kind);

  it("the app's first run: “Your first videos are ready” with how many wait (instead of, never as well as, “ready to review”); a later run: “ready to review”", async () => {
    const sent = fakeExpo();
    const wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await p.db.top("workspaces").update(wsA, { planId: "studio" });
    await p.credits.grant(wsA, 2000, { reason: "test", idempotencyKey: "devices-test", actor: "system" });
    const appId = (await seedApp(p, wsA)).appId;
    const phone = await link(app, dev("alice"));
    await client(app, phone.token).put("/v1/me/device/push", { token: "ExponentPushToken[autopilotphone01]" });
    const started = await alice.post(`/v1/workspaces/${wsA}/apps/${appId}/autopilot`, { goal: "More installs from students", maxCredits: 400, autoApproveCredits: 100, variants: 2 });
    expect(started.status).toBe(202);
    await p.inline!.drain();
    const posts = (await alice.get(`/v1/workspaces/${wsA}/autopilots/${started.body.autopilot.id}`)).body.posts as J[];
    const waiting = posts.filter((x) => x.status === "awaiting_approval").length;
    expect(waiting).toBeGreaterThan(0);
    expect(kinds(sent)).toEqual(["first_run_studied", "first_videos_ready"]);
    const ready = sent.find((s) => (s.body as J[])[0]?.data?.kind === "first_videos_ready")!;
    expect((ready.body as J[])[0]).toMatchObject({ title: "Your first videos are ready", body: `${waiting} post${waiting === 1 ? " is" : "s are"} waiting for your OK.`, data: { url: `/?w=${wsA}&a=${appId}` } });

    // The first-run note started the app's posts-ready hour (so no "ready to review" right after it).
    const window = p.db.global(`push-ready-${wsA}-${appId}`, z.object({ lastSentAt: z.string() }));
    expect(Date.now() - Date.parse((await window.get())!.lastSentAt)).toBeLessThan(60_000);
    // A later run of the same app, outside that hour: the usual "ready to review".
    await alice.post(`/v1/workspaces/${wsA}/autopilots/${started.body.autopilot.id}/cancel`);
    await window.set({ lastSentAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    sent.length = 0;
    const again = await alice.post(`/v1/workspaces/${wsA}/apps/${appId}/autopilot`, { goal: "More installs from teachers", maxCredits: 400, autoApproveCredits: 100, variants: 2 });
    expect(again.status, again.text).toBe(202);
    await p.inline!.drain();
    expect(kinds(sent)).toEqual(["posts_ready"]);
  });
});
