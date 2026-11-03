import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify, type ECDH } from "node:crypto";
import { seedApp } from "@muselaunch/agents/testing";
import { advanceCreateRun } from "@muselaunch/autopilot";
import { autopilotPlatform } from "@muselaunch/autopilot/testing";
import { WEB_PUSH_MAX_PER_USER } from "@muselaunch/contracts";
import {
  createTestPlatform,
  generateWebPushKeys,
  notifyFirstRunStudied,
  notifyFirstVideosReady,
  notifyPostLive,
  notifyPostsReady,
  notifyRunNeedsYou,
  notifyVideoReady,
  saveWebPushSubscription,
  sendPushToUsers,
  setPushFetch,
  setWebPushSender,
  webPushKeys,
  webPushSubscriptionId,
  type PushFetch,
  type WebPushRequest,
} from "@muselaunch/platform";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";

/**
 * Notifications in the browser (Web Push): routes/web-push.ts, platform/web-push.ts and the shared
 * fan-out in platform/push.ts.
 *
 *  - The API: the server's public key; a web session saves, lists, removes and tests its browsers;
 *    phone tokens, other people and unsafe endpoints are refused; production without keys says off.
 *  - Sending: what reaches the push service is a real RFC 8291 message for that browser (decrypted
 *    here with the browser's own key) with a valid VAPID signature; 404/410 remove the browser.
 *  - One note reaches phones (Expo) and browsers; failures never reach the caller.
 *  - The moments (finished studying, first videos ready, needs you, video ready) go out once each,
 *    to the right people, from the server: through a real first Autopilot run and a Create run.
 */

// biome-ignore lint: loose JSON in tests
type J = any;
type App = ReturnType<typeof buildApp>;

const CHROME_WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36";

function client(app: App, auth: string | null, extra: Record<string, string> = {}) {
  const send = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await app.request(path, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), "content-type": "application/json", "user-agent": CHROME_WINDOWS, ...extra, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as J, text, headers: res.headers };
  };
  return {
    get: (path: string) => send("GET", path),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => send("POST", path, body ?? {}, headers),
    put: (path: string, body?: unknown) => send("PUT", path, body ?? {}),
    del: (path: string, body?: unknown) => send("DELETE", path, body),
  };
}

const dev = (uid: string) => `dev:${uid}:${uid}@example.com`;
let ipSeq = 0;

/** A browser: a real P-256 key pair and auth secret, so the test can read what the server sends it. */
interface Browser {
  ecdh: ECDH;
  auth: Buffer;
  sub: { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
}
function browser(host = "fcm.googleapis.com"): Browser {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const endpoint = `https://${host}/fcm/send/${randomBytes(30).toString("base64url")}`;
  return { ecdh, auth, sub: { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
}

/** RFC 8291 (aes128gcm, one record): decrypt a pushed message with the browser's private key. */
function decrypt(b: Browser, body: Uint8Array | null): J {
  const buf = Buffer.from(body ?? []);
  const salt = buf.subarray(0, 16);
  const idlen = buf[20]!;
  const asPublic = buf.subarray(21, 21 + idlen);
  const ct = buf.subarray(21 + idlen);
  const hmac = (key: Buffer, data: Buffer) => createHmac("sha256", key).update(data).digest();
  const ikm = hmac(hmac(b.auth, b.ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from("WebPush: info\0"), b.ecdh.getPublicKey(), asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString("utf8"));
}

/** RFC 8292: the VAPID header's JWT, checked against the key it names. */
function vapid(headers: Record<string, string>): { ok: boolean; k: string; claims: J } {
  const m = (headers.Authorization ?? headers.authorization ?? "").match(/^vapid t=([^,]+), k=(.+)$/);
  if (!m) return { ok: false, k: "", claims: null };
  const [h, pl, sig] = m[1]!.split(".");
  const pub = Buffer.from(m[2]!, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: pub.subarray(1, 33).toString("base64url"), y: pub.subarray(33).toString("base64url") }, format: "jwk" });
  const ok = verify("sha256", Buffer.from(`${h}.${pl}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig!, "base64url"));
  return { ok, k: m[2]!, claims: JSON.parse(Buffer.from(pl!, "base64url").toString("utf8")) };
}

/** The push services, faked at the network edge (the request is exactly what would go out). */
function pushService(opts: { status?: (endpoint: string) => number; throws?: boolean } = {}) {
  const sent: WebPushRequest[] = [];
  setWebPushSender(async (req) => {
    sent.push(req);
    if (opts.throws) throw new Error("network down");
    return { status: opts.status?.(req.endpoint) ?? 201 };
  });
  return sent;
}
/** What each browser received, decrypted. */
const received = (sent: WebPushRequest[], bs: Browser[]) => sent.map((r) => ({ to: r.endpoint, msg: decrypt(bs.find((b) => b.sub.endpoint === r.endpoint)!, r.body) }));

function fakeExpo() {
  const sent: J[] = [];
  const f: PushFetch = async (_url, init) => {
    const body = JSON.parse(init.body) as J[];
    sent.push(...body);
    return { ok: true, status: 200, json: async () => ({ data: body.map((_, i) => ({ status: "ok", id: `tkt_${Date.now()}_${i}` })) }) };
  };
  setPushFetch(f);
  return sent;
}

async function linkPhone(app: App, uid: string, expoToken?: string): Promise<string> {
  const made = await client(app, dev(uid)).post("/v1/me/device-links");
  const r = await client(app, null, { "x-forwarded-for": `198.18.0.${++ipSeq}` }).post("/v1/device-links/redeem", { code: made.body.code, deviceName: `${uid} phone`, platform: "android" });
  expect(r.status, r.text).toBe(201);
  if (expoToken) expect((await client(app, r.body.token).put("/v1/me/device/push", { token: expoToken })).status).toBe(200);
  return r.body.token;
}

afterEach(() => {
  setWebPushSender(null);
  setPushFetch(null);
});

// ---------------------------------------------------------------------------
// The API
// ---------------------------------------------------------------------------

describe("Browser notifications: the API", () => {
  const p = createTestPlatform();
  const app = buildApp(p);
  const alice = client(app, dev("alice"));
  const bob = client(app, dev("bob"));

  beforeAll(async () => {
    await alice.post("/v1/workspaces", { name: "Alice Apps" });
    await bob.post("/v1/workspaces", { name: "Bob Studio" });
  });

  it("gives the server's public key (a local server without keys makes a temporary pair)", async () => {
    const r = await alice.get("/v1/push/web/config");
    expect(r.status).toBe(200);
    expect(r.body.enabled).toBe(true);
    const key = Buffer.from(r.body.publicKey, "base64url");
    expect(key).toHaveLength(65);
    expect(key[0]).toBe(4);
    expect(r.body).not.toHaveProperty("privateKey");
    expect(webPushKeys(p)).toMatchObject({ ephemeral: true, publicKey: r.body.publicKey });
    expect(JSON.stringify(r.body)).not.toContain(webPushKeys(p)!.privateKey);
  });

  it("saves this browser (upsert by endpoint), labelled from the browser; the list shows the label and dates only", async () => {
    const b = browser();
    const r = await alice.post("/v1/me/web-push", b.sub);
    expect(r.status, r.text).toBe(201);
    expect(r.body.browser).toMatchObject({ id: webPushSubscriptionId(b.sub.endpoint), label: "Chrome on Windows" });
    const stored = await p.db.top("webPushSubscriptions").get(webPushSubscriptionId(b.sub.endpoint));
    expect(stored).toMatchObject({ userId: "alice", endpoint: b.sub.endpoint, keys: b.sub.keys, failures: 0, keyId: webPushKeys(p)!.keyId });
    // Again (the page re-sends it on each visit): the same record, its first date kept.
    const again = await alice.post("/v1/me/web-push", b.sub, { "user-agent": CHROME_ANDROID });
    expect(again.body.browser).toMatchObject({ id: r.body.browser.id, createdAt: r.body.browser.createdAt, label: "Chrome on Android" });
    const list = await alice.get("/v1/me/web-push");
    expect(list.status).toBe(200);
    expect(list.body.enabled).toBe(true);
    const mine = list.body.items.filter((i: J) => i.id === r.body.browser.id);
    expect(mine).toHaveLength(1);
    expect(Object.keys(mine[0]).sort()).toEqual(["createdAt", "id", "label"]);
    expect(list.text).not.toContain(b.sub.endpoint);
    expect(list.text).not.toContain(b.sub.keys.auth);
  });

  it("refuses unsafe or malformed subscriptions and stores none of them", async () => {
    const before = (await p.db.top("webPushSubscriptions").list({ limit: 200 })).items.length;
    const good = browser().sub;
    const bad: [string, unknown][] = [
      ["http", { ...good, endpoint: "http://fcm.googleapis.com/fcm/send/abc" }],
      ["localhost", { ...good, endpoint: "https://localhost/push/abc" }],
      ["loopback", { ...good, endpoint: "https://127.0.0.1/push/abc" }],
      ["private", { ...good, endpoint: "https://10.0.0.5/push/abc" }],
      ["metadata", { ...good, endpoint: "https://169.254.169.254/latest" }],
      ["ipv6 loopback", { ...good, endpoint: "https://[::1]/push" }],
      ["internal name", { ...good, endpoint: "https://push.corp.internal/abc" }],
      ["odd port", { ...good, endpoint: "https://fcm.googleapis.com:8443/fcm/send/abc" }],
      ["credentials", { ...good, endpoint: "https://user:pw@fcm.googleapis.com/fcm/send/abc" }],
      ["too long", { ...good, endpoint: `https://fcm.googleapis.com/fcm/send/${"a".repeat(3000)}` }],
      ["not a url", { ...good, endpoint: "not a url at all" }],
      ["short key", { ...good, keys: { ...good.keys, p256dh: "A".repeat(80) } }],
      ["bad auth", { ...good, keys: { ...good.keys, auth: "!!!!!!!!!!!!!!!!!!!!!!" } }],
      ["no keys", { endpoint: good.endpoint }],
    ];
    for (const [what, sub] of bad) {
      const r = await alice.post("/v1/me/web-push", sub);
      expect([400, 422], `${what}: ${r.status} ${r.text}`).toContain(r.status);
    }
    expect((await p.db.top("webPushSubscriptions").list({ limit: 200 })).items).toHaveLength(before);
  });

  it("a linked phone can't add, list, remove or test browsers; no token at all is 401", async () => {
    const phone = client(app, await linkPhone(app, "alice"));
    const b = browser();
    expect((await phone.post("/v1/me/web-push", b.sub)).status).toBe(403);
    expect((await phone.get("/v1/me/web-push")).status).toBe(403);
    expect((await phone.del("/v1/me/web-push", { endpoint: b.sub.endpoint })).status).toBe(403);
    expect((await phone.post("/v1/me/web-push/test")).status).toBe(403);
    for (const [method, path] of [
      ["GET", "/v1/push/web/config"],
      ["GET", "/v1/me/web-push"],
      ["POST", "/v1/me/web-push"],
      ["DELETE", "/v1/me/web-push"],
      ["POST", "/v1/me/web-push/test"],
    ] as const) {
      expect((await app.request(path, { method })).status, `${method} ${path}`).toBe(401);
    }
  });

  it("someone else's browsers are never listed, removed or sent to", async () => {
    const a = browser();
    const id = (await alice.post("/v1/me/web-push", a.sub)).body.browser.id;
    expect((await bob.get("/v1/me/web-push")).body.items.some((i: J) => i.id === id)).toBe(false);
    expect((await bob.del("/v1/me/web-push", { id })).status).toBe(404);
    expect((await bob.del("/v1/me/web-push", { endpoint: a.sub.endpoint })).status).toBe(404);
    expect(await p.db.top("webPushSubscriptions").get(id)).toBeTruthy();
    // Bob's test goes to Bob's browsers only.
    const bb = browser("updates.push.services.mozilla.com");
    await bob.post("/v1/me/web-push", bb.sub);
    const sent = pushService();
    const t = await bob.post("/v1/me/web-push/test");
    expect(t.status, t.text).toBe(200);
    expect(sent.map((s) => s.endpoint)).toEqual([bb.sub.endpoint]);
  });

  it("the same browser signed in as someone else now belongs to them only", async () => {
    const shared = browser();
    await alice.post("/v1/me/web-push", shared.sub);
    await bob.post("/v1/me/web-push", shared.sub);
    const id = webPushSubscriptionId(shared.sub.endpoint);
    expect((await alice.get("/v1/me/web-push")).body.items.some((i: J) => i.id === id)).toBe(false);
    expect((await bob.get("/v1/me/web-push")).body.items.some((i: J) => i.id === id)).toBe(true);
  });

  it("removes this browser by its endpoint, and another one by id (Settings → Remove)", async () => {
    const nina = client(app, dev("nina"));
    const one = browser();
    const two = browser();
    await nina.post("/v1/me/web-push", one.sub);
    const twoId = (await nina.post("/v1/me/web-push", two.sub)).body.browser.id;
    expect((await nina.del("/v1/me/web-push", { endpoint: one.sub.endpoint })).status).toBe(200);
    expect((await nina.del("/v1/me/web-push", { id: twoId })).status).toBe(200);
    expect((await nina.get("/v1/me/web-push")).body.items).toEqual([]);
    expect((await nina.del("/v1/me/web-push", { id: twoId })).status).toBe(404);
  });

  it("keeps at most a person's newest browsers; saving is limited to 20 per 10 minutes", async () => {
    const zed = client(app, dev("zed"));
    const all = Array.from({ length: WEB_PUSH_MAX_PER_USER + 2 }, () => browser());
    const statuses: number[] = [];
    for (const b of all) statuses.push((await zed.post("/v1/me/web-push", b.sub)).status);
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(20)).toEqual([429, 429]);
    // Past the limit (over days, say): the oldest goes.
    for (const b of all.slice(20)) await saveWebPushSubscription(p, "zed", b.sub, CHROME_WINDOWS);
    const ids = (await zed.get("/v1/me/web-push")).body.items.map((i: J) => i.id);
    expect(ids).toHaveLength(WEB_PUSH_MAX_PER_USER);
    expect(ids).toContain(webPushSubscriptionId(all.at(-1)!.sub.endpoint));
  });

  it("“Send a test”: a real encrypted message with a valid signature, to the caller's browsers; limited to 5 per 10 minutes", async () => {
    const tess = client(app, dev("tess"));
    expect((await tess.post("/v1/me/web-push/test")).status).toBe(404); // no browsers yet: says so
    const b = browser();
    await tess.post("/v1/me/web-push", b.sub);
    const sent = pushService();
    const r = await tess.post("/v1/me/web-push/test");
    expect(r.status, r.text).toBe(200);
    expect(r.body.result).toMatchObject({ browsers: 1, sent: 1, removed: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    const req = sent[0]!;
    expect(req.endpoint).toBe(b.sub.endpoint);
    expect(req.headers).toMatchObject({ "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", Urgency: "normal" });
    expect(Number(req.headers.TTL)).toBe(600);
    expect(req.headers.Topic).toMatch(/^[A-Za-z0-9_-]{1,32}$/);
    expect(decrypt(b, req.body)).toEqual({ v: 1, title: "Notifications are on", body: expect.stringContaining("videos are ready"), url: "/", tag: "ml-test", kind: "test" });
    const v = vapid(req.headers);
    expect(v.ok).toBe(true);
    expect(v.k).toBe(webPushKeys(p)!.publicKey);
    expect(v.claims).toMatchObject({ aud: "https://fcm.googleapis.com", sub: expect.stringMatching(/^(mailto:|https:)/) });
    expect(v.claims.exp * 1000).toBeGreaterThan(Date.now());
    // Five tries in 10 minutes (the one with no browsers counted too): the sixth is refused.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await tess.post("/v1/me/web-push/test")).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
  });

  it("a browser the push service says is gone (410, 404) is removed; a busy service (500) keeps it; refusals in a row drop it", async () => {
    const uma = client(app, dev("uma"));
    const gone = browser();
    const missing = browser("web.push.apple.com");
    const busy = browser("wns2-by3p.notify.windows.com");
    const refused = browser("updates.push.services.mozilla.com");
    for (const b of [gone, missing, busy, refused]) await uma.post("/v1/me/web-push", b.sub);
    const status = (e: string) => (e === gone.sub.endpoint ? 410 : e === missing.sub.endpoint ? 404 : e === busy.sub.endpoint ? 500 : 403);
    pushService({ status });
    const r = await uma.post("/v1/me/web-push/test");
    expect(r.body.result).toMatchObject({ browsers: 4, sent: 0, removed: 2, failed: 2 });
    const left = (await uma.get("/v1/me/web-push")).body.items.map((i: J) => i.id).sort();
    expect(left).toEqual([webPushSubscriptionId(busy.sub.endpoint), webPushSubscriptionId(refused.sub.endpoint)].sort());
    expect((await p.db.top("webPushSubscriptions").get(webPushSubscriptionId(busy.sub.endpoint)))!.failures).toBe(0);
    expect((await p.db.top("webPushSubscriptions").get(webPushSubscriptionId(refused.sub.endpoint)))!.failures).toBe(1);
    // Refused four more times (through the fan-out, not the rate-limited test route): dropped.
    for (let i = 0; i < 4; i++) await sendPushToUsers(p, ["uma"], { kind: "test", title: "t", body: "b", url: "/", workspaceId: "w" });
    expect(await p.db.top("webPushSubscriptions").get(webPushSubscriptionId(refused.sub.endpoint))).toBeNull();
    expect(await p.db.top("webPushSubscriptions").get(webPushSubscriptionId(busy.sub.endpoint))).toBeTruthy();
  });

  it("production without keys: off, and the API says so honestly", async () => {
    const off = createTestPlatform({ APP_ENV: "staging" });
    const offApp = buildApp(off);
    const c = client(offApp, dev("olga"));
    expect((await c.get("/v1/push/web/config")).body).toEqual({ enabled: false });
    const r = await c.post("/v1/me/web-push", browser().sub);
    expect(r.status).toBe(503);
    expect(r.body.error.userMessage).toMatch(/aren’t set up on this server/);
    expect((await c.post("/v1/me/web-push/test")).status).toBe(503);
    expect((await c.get("/v1/me/web-push")).body).toEqual({ items: [], enabled: false });
  });

  it("configured keys are used as given; a broken pair turns it off", async () => {
    const pair = generateWebPushKeys();
    const on = createTestPlatform({ APP_ENV: "staging", WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey, NEXT_PUBLIC_CONTACT_EMAIL: "hello@muselaunch.app" });
    expect(webPushKeys(on)).toMatchObject({ publicKey: pair.publicKey, ephemeral: false, subject: "mailto:hello@muselaunch.app" });
    expect((await client(buildApp(on), dev("pat")).get("/v1/push/web/config")).body).toEqual({ enabled: true, publicKey: pair.publicKey });
    const broken = createTestPlatform({ WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: "not-a-key" });
    expect(webPushKeys(broken)).toBeNull();
    const half = createTestPlatform({ WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey });
    expect(webPushKeys(half)).toBeNull();
    // The subject falls back to the operator email, then the https web address.
    expect(webPushKeys(createTestPlatform({ OPERATOR_EMAIL: "ops@example.com" }))!.subject).toBe("mailto:ops@example.com");
    expect(webPushKeys(createTestPlatform({ PUBLIC_WEB_URL: "https://muselaunch.example.com" }))!.subject).toBe("https://muselaunch.example.com");
  });

  it("a browser subscribed with another server key isn't sent to, and goes after a few tries", async () => {
    const vic = client(app, dev("vic"));
    const b = browser();
    const id = (await vic.post("/v1/me/web-push", b.sub)).body.browser.id;
    await p.db.top("webPushSubscriptions").update(id, { keyId: "0000000000000000" });
    const sent = pushService();
    for (let i = 0; i < 5; i++) await sendPushToUsers(p, ["vic"], { kind: "test", title: "t", body: "b", url: "/", workspaceId: "w" });
    expect(sent).toEqual([]);
    expect(await p.db.top("webPushSubscriptions").get(id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// One note, phones and browsers
// ---------------------------------------------------------------------------

describe("One note reaches linked phones and browsers", () => {
  const p = createTestPlatform();
  const app = buildApp(p);
  const alice = client(app, dev("alice"));
  let wid = "";
  let appId = "";
  const b = browser();

  beforeAll(async () => {
    wid = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    appId = (await seedApp(p, wid, { name: "Pocket Play: your couch, your game" })).appId;
    await linkPhone(app, "alice", "ExponentPushToken[alicephonealice1]");
    await alice.post("/v1/me/web-push", b.sub);
  });

  it("the same note goes to the phone (app path) and the browser (web path)", async () => {
    const expo = fakeExpo();
    const sent = pushService();
    const r = await sendPushToUsers(p, ["alice"], { kind: "post_live", title: "Pocket Play", body: "Your post is live", url: `/results?w=${wid}&a=${appId}`, webUrl: `/w/${wid}/a/${appId}/results`, tag: "ml-x", workspaceId: wid, appId });
    expect(r).toMatchObject({ devices: 1, browsers: 1, sent: 2, removed: 0, failed: 0, phone: { sent: 1 }, web: { sent: 1 } });
    expect(expo).toHaveLength(1);
    expect(expo[0]).toMatchObject({ to: "ExponentPushToken[alicephonealice1]", title: "Pocket Play", data: { url: `/results?w=${wid}&a=${appId}` } });
    expect(received(sent, [b])[0]!.msg).toMatchObject({ title: "Pocket Play", body: "Your post is live", url: `/w/${wid}/a/${appId}/results`, tag: "ml-x", kind: "post_live" });
  });

  it("“post is live” and “posts ready” reach a browser too (Results / Home)", async () => {
    fakeExpo();
    const sent = pushService();
    await notifyPostLive(p, wid, { appId, channel: "youtube", title: "Couch co-op in 20 seconds" });
    await p.db.ws(wid).collection("approvals").create({ appId, action: "publish", subject: { entity: "scheduledPosts", id: "pst_x1" }, snapshotHash: "h", summary: "Publish", requestedBy: "alice", status: "pending" }, { actor: "alice" });
    await notifyPostsReady(p, wid, appId);
    const msgs = received(sent, [b]).map((x) => x.msg);
    expect(msgs[0]).toMatchObject({ kind: "post_live", url: `/w/${wid}/a/${appId}/results`, body: expect.stringContaining("YouTube") });
    expect(msgs[1]).toMatchObject({ kind: "posts_ready", body: "1 post is ready to review", url: `/w/${wid}/a/${appId}/home` });
  });

  it("never throws when the push services can't be reached", async () => {
    setPushFetch(async () => {
      throw new Error("expo down");
    });
    pushService({ throws: true });
    const r = await sendPushToUsers(p, ["alice"], { kind: "test", title: "t", body: "b", url: "/", workspaceId: wid });
    expect(r).toMatchObject({ sent: 0, failed: 2, phone: { failed: 1 }, web: { failed: 1 } });
    await expect(notifyPostLive(p, wid, { appId, channel: "instagram" })).resolves.toMatchObject({ sent: 0 });
    // The browser stays: a network problem on our side isn't the browser's fault.
    expect(await p.db.top("webPushSubscriptions").get(webPushSubscriptionId(b.sub.endpoint))).toMatchObject({ failures: 0 });
  });
});

// ---------------------------------------------------------------------------
// The moments: once each, to the right people
// ---------------------------------------------------------------------------

describe("The moments go out once each, to the right people", () => {
  const p = createTestPlatform();
  const app = buildApp(p);
  const alice = client(app, dev("alice")); // owner
  const eddie = client(app, dev("eddie")); // editor (no publish)
  const carol = client(app, dev("carol")); // viewer
  let wid = "";
  let appId = "";
  const bs = { alice: browser(), eddie: browser(), carol: browser() };
  const to = (sent: WebPushRequest[]) => sent.map((s) => Object.entries(bs).find(([, b]) => b.sub.endpoint === s.endpoint)?.[0]).sort();
  const msgs = (sent: WebPushRequest[]) => received(sent, Object.values(bs)).map((x) => x.msg);

  beforeAll(async () => {
    wid = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    appId = (await seedApp(p, wid, { name: "Pocket Play: your couch, your game" })).appId;
    for (const [uid, role] of [
      ["eddie", "editor"],
      ["carol", "viewer"],
    ] as const)
      await p.db.ws(wid).collection("members").create({ id: uid, userId: uid, email: `${uid}@example.com`, role, canPublish: false, canManageAccounts: false, status: "active" }, { actor: "alice" });
    for (const [who, c] of [
      ["alice", alice],
      ["eddie", eddie],
      ["carol", carol],
    ] as const)
      expect((await c.post("/v1/me/web-push", bs[who].sub)).status).toBe(201);
  });

  it("“Muse has finished studying Pocket Play” (short name, Home), once per run", async () => {
    const sent = pushService();
    const run = { id: "apl_first1", appId, startedBy: "alice" };
    expect(await notifyFirstRunStudied(p, wid, run)).toMatchObject({ browsers: 2, sent: 2 });
    expect(await notifyFirstRunStudied(p, wid, run)).toBeNull();
    expect(to(sent)).toEqual(["alice", "eddie"]); // who can make content; not the viewer
    expect(msgs(sent)[0]).toEqual({ v: 1, title: "Muse has finished studying Pocket Play", body: "Now making your first videos.", url: `/w/${wid}/a/${appId}/home`, tag: "ml-run-apl_first1", kind: "first_run_studied" });
  });

  it("“Your first videos are ready” replaces the posts-ready note (never both), once per run", async () => {
    for (const i of [1, 2]) await p.db.ws(wid).collection("approvals").create({ appId, action: "publish", subject: { entity: "scheduledPosts", id: `pst_first${i}` }, snapshotHash: "h", summary: "Publish", requestedBy: "alice", status: "pending" }, { actor: "alice" });
    const sent = pushService();
    const run = { id: "apl_first1", appId, startedBy: "alice" };
    await notifyFirstVideosReady(p, wid, run);
    expect(await notifyFirstVideosReady(p, wid, run)).toBeNull();
    // A posts-ready note right after (another path drafting a post): within the same hour, nothing.
    expect(await notifyPostsReady(p, wid, appId)).toBeNull();
    expect(to(sent)).toEqual(["alice"]); // who can schedule posts
    expect(msgs(sent)).toEqual([{ v: 1, title: "Your first videos are ready", body: "2 posts are waiting for your OK.", url: `/w/${wid}/a/${appId}/home`, tag: "ml-run-apl_first1", kind: "first_videos_ready" }]);
  });

  it("“Muse needs you for a moment”: once per decision, to who can answer it; a Create video opens the Create page", async () => {
    const sent = pushService();
    const ap = { id: "apl_needs1", appId, startedBy: "eddie", kind: "autopilot" as const };
    const spend = { key: "apr_1", what: "finishing the videos needs your OK (about 40 credits)", caps: ["content.approve" as const, "billing.manage" as const] };
    await notifyRunNeedsYou(p, wid, ap, spend);
    expect(await notifyRunNeedsYou(p, wid, ap, spend)).toBeNull();
    // The starter (an editor) and the owner who can approve spending; never the viewer.
    expect(to(sent)).toEqual(["alice", "eddie"]);
    expect(msgs(sent)[0]).toMatchObject({ title: "Muse needs you for a moment", body: "Pocket Play: finishing the videos needs your OK (about 40 credits).", url: `/w/${wid}/a/${appId}/home`, tag: "ml-run-apl_needs1", kind: "needs_you" });
    expect(sent[0]!.headers.Urgency).toBe("high");
    // A new decision in the same run: once more.
    sent.length = 0;
    await notifyRunNeedsYou(p, wid, ap, { ...spend, key: "apr_2" });
    expect(sent).toHaveLength(2);
    sent.length = 0;
    await notifyRunNeedsYou(p, wid, { id: "cmp_video1", appId, startedBy: "alice", kind: "create" }, { key: "spend:final:cmp_1:v1", what: "your video came out longer than you chose", caps: ["content.write"] });
    expect(msgs(sent)[0]).toMatchObject({ url: `/w/${wid}/a/${appId}/create?run=cmp_video1`, body: "Pocket Play: your video came out longer than you chose." });
  });

  it("“Your video is ready” with its title, once; the starter gets it even without the publish right", async () => {
    const sent = pushService();
    const run = { id: "cmp_eddie1", appId, startedBy: "eddie" };
    await notifyVideoReady(p, wid, run, { title: "Couch co-op in 20 seconds" });
    expect(await notifyVideoReady(p, wid, run, { title: "Couch co-op in 20 seconds" })).toBeNull();
    expect(to(sent)).toEqual(["alice", "eddie"]);
    expect(msgs(sent)[0]).toEqual({ v: 1, title: "Your video is ready", body: "“Couch co-op in 20 seconds” is ready to watch and post.", url: `/w/${wid}/a/${appId}/create?run=cmp_eddie1`, tag: "ml-run-cmp_eddie1", kind: "video_ready" });
  });

  it("someone who left the workspace gets nothing, even for a run they started", async () => {
    await p.db.ws(wid).collection("members").update("carol", { status: "removed" }, { actor: "alice" });
    const sent = pushService();
    await notifyVideoReady(p, wid, { id: "cmp_carol1", appId, startedBy: "carol" }, { title: "Old video" });
    expect(to(sent)).toEqual(["alice"]);
  });

  it("nobody with notifications on: nothing sent and nothing claimed (it can go out later)", async () => {
    const q = createTestPlatform();
    const qa = client(buildApp(q), dev("quinn"));
    const qw = (await qa.post("/v1/workspaces", { name: "Quinn" })).body.workspace.id;
    const qApp = (await seedApp(q, qw)).appId;
    const run = { id: "apl_q", appId: qApp, startedBy: "quinn" };
    expect(await notifyFirstRunStudied(q, qw, run)).toBeNull();
    const b = browser();
    await qa.post("/v1/me/web-push", b.sub);
    const sent = pushService();
    expect(await notifyFirstRunStudied(q, qw, run)).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// From the server, with every tab closed: a real first run and a Create video
// ---------------------------------------------------------------------------

describe("A first Autopilot run notifies from the server (no browser open)", () => {
  const h = autopilotPlatform();
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, dev("alice"));

  it("finished studying → needs you (once) → first videos ready; never “posts ready” for that batch", async () => {
    const wid = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await p.db.top("workspaces").update(wid, { planId: "studio" });
    await p.credits.grant(wid, 1000, { reason: "test", idempotencyKey: "web-push-test", actor: "system" });
    const appId = (await seedApp(p, wid)).appId;
    const b = browser();
    await alice.post("/v1/me/web-push", b.sub);
    const sent = pushService();
    const expo = fakeExpo();
    // Nothing spent without asking: the run stops for its OK before finishing the videos.
    const started = await alice.post(`/v1/workspaces/${wid}/apps/${appId}/autopilot`, { goal: "More installs from students", maxCredits: 400, autoApproveCredits: 0, variants: 2 });
    expect(started.status).toBe(202);
    const id = started.body.autopilot.id as string;
    await p.inline!.drain();
    let detail = (await alice.get(`/v1/workspaces/${wid}/autopilots/${id}`)).body;
    expect(detail.autopilot.status).toBe("awaiting_user");
    let kinds = received(sent, [b]).map((x) => x.msg.kind);
    expect(kinds).toEqual(["first_run_studied", "needs_you"]);
    const [studied, needs] = received(sent, [b]).map((x) => x.msg);
    expect(studied).toMatchObject({ title: "Muse has finished studying Tidy Timer", body: "Now making your first videos.", url: `/w/${wid}/a/${appId}/home`, tag: `ml-run-${id}` });
    expect(needs).toMatchObject({ title: "Muse needs you for a moment", body: expect.stringMatching(/^Tidy Timer: .+\.$/), url: `/w/${wid}/a/${appId}/home` });
    // Looking again (the wake-up sweep, a second step for the same state) sends nothing more.
    await p.inline!.drain();
    expect(sent).toHaveLength(2);

    expect((await alice.post(`/v1/workspaces/${wid}/autopilots/${id}/checkpoint/approve`, { note: "go" })).status).toBe(202);
    await p.inline!.drain();
    detail = (await alice.get(`/v1/workspaces/${wid}/autopilots/${id}`)).body;
    const waiting = (detail.posts as J[]).filter((x) => x.status === "awaiting_approval").length;
    expect(waiting).toBeGreaterThan(0);
    kinds = received(sent, [b]).map((x) => x.msg.kind);
    expect(kinds.filter((k) => k === "first_run_studied")).toHaveLength(1);
    expect(kinds.filter((k) => k === "first_videos_ready")).toHaveLength(1);
    expect(kinds).not.toContain("posts_ready");
    const ready = received(sent, [b]).find((x) => x.msg.kind === "first_videos_ready")!.msg;
    expect(ready).toMatchObject({ title: "Your first videos are ready", body: `${waiting} post${waiting === 1 ? " is" : "s are"} waiting for your OK.`, url: `/w/${wid}/a/${appId}/home` });
    // No phone linked: Expo was never called.
    expect(expo).toEqual([]);
  });
});

describe("A Create video notifies from the server", () => {
  const h = autopilotPlatform();
  const p = h.p;
  const app = buildApp(p);
  const alice = client(app, dev("alice"));
  let wid = "";
  let appId = "";
  const b = browser();

  beforeAll(async () => {
    wid = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    await p.credits.grant(wid, 2000, { reason: "test", idempotencyKey: "web-push-create", actor: "system" });
    appId = (await seedApp(p, wid)).appId;
    await alice.post("/v1/me/web-push", b.sub);
  });

  it("“Your video is ready” with the video's title, once, opening the Create page on it", async () => {
    const sent = pushService();
    const created = await alice.post(`/v1/workspaces/${wid}/apps/${appId}/campaigns`, {
      request: "Show how Distraction blocking keeps a study session calm.",
      goal: "feature_announcement",
      channels: ["instagram"],
      deliverables: [{ kind: "feature_promo", channel: "instagram", aspectRatio: "9:16", durationSec: 60, count: 1 }],
      conceptCount: 3,
      origin: "create",
    });
    expect(created.status).toBe(202);
    const id = created.body.campaign.id as string;
    await p.inline!.drain();
    const run = (await alice.get(`/v1/workspaces/${wid}/create-runs/${id}`)).body.run;
    expect(run.status).toBe("done");
    await advanceCreateRun(p, wid, id, { source: "sweep" });
    const msgs = received(sent, [b]).map((x) => x.msg);
    expect(msgs.filter((m) => m.kind === "video_ready")).toHaveLength(1);
    const comp = await p.db.ws(wid).collection("compositions").getOrThrow(run.compositionId);
    expect(msgs.find((m) => m.kind === "video_ready")).toEqual({ v: 1, title: "Your video is ready", body: `“${comp.title}” is ready to watch and post.`, url: `/w/${wid}/a/${appId}/create?run=${id}`, tag: `ml-run-${id}`, kind: "video_ready" });
  });

  it("stops for a decision (not enough credits): “Muse needs you for a moment” once, opening the Create page", async () => {
    const ws = p.db.ws(wid);
    const campaign = await ws.collection("campaigns").create(
      {
        appId,
        name: "Calm focus",
        goal: "awareness",
        request: "Introduce Tidy Timer to students.",
        channels: ["instagram"],
        deliverables: [{ kind: "short_video", channel: "instagram", aspectRatio: "9:16", durationSec: 20, count: 1 }],
        status: "concepts_ready",
        origin: "create",
        createRun: { startedBy: "alice", actingAs: "alice", status: "working", stage: "plan", waits: 0, jobIds: [], touchedAt: new Date().toISOString() },
      },
      { actor: "alice" },
    );
    await ws.collection("campaignVariants").create(
      { appId, campaignId: campaign.id, title: "Calm in exam season", angleType: "emotional_problem", hook: "Calm", audience: "Students", keyMessage: "Calm focus", rationale: "Students study in blocks.", hypothesis: "A calm hook works.", successMetric: { metric: "installs" }, status: "proposed", targetDurationSec: 20 },
      { actor: "seed" },
    );
    const bal = await p.credits.balance(wid);
    const hold = await p.credits.reserve(wid, bal.available - 2, { operation: "test", idempotencyKey: "drain-credits-web-push", actor: "system" });
    const sent = pushService();
    await advanceCreateRun(p, wid, campaign.id, { source: "sweep" });
    await advanceCreateRun(p, wid, campaign.id, { source: "sweep" });
    expect((await alice.get(`/v1/workspaces/${wid}/create-runs/${campaign.id}`)).body.run).toMatchObject({ status: "needs_you", decision: { kind: "credits" } });
    const msgs = received(sent, [b]).map((x) => x.msg);
    expect(msgs).toEqual([{ v: 1, title: "Muse needs you for a moment", body: "Tidy Timer: not enough credits to finish your video.", url: `/w/${wid}/a/${appId}/create?run=${campaign.id}`, tag: `ml-run-${campaign.id}`, kind: "needs_you" }]);
    await p.credits.release(wid, hold.reservationId, { actor: "system", reason: "test" });
  });
});
