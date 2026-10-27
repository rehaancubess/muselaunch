import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRevenueCatFetch } from "@muselaunch/analytics";
import { createComposition } from "@muselaunch/compositions/store";
import { ENTITY_SCHEMAS, JOB_TYPES, type CompositionDoc } from "@muselaunch/contracts";
import { MemoryDb } from "@muselaunch/db";
import { createPlatform, createRunner, loadConfig, workspaceKey, type HandlerRegistry, type Logger } from "@muselaunch/platform";
import { beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { workspaceScope } from "./middleware";

/* eslint-disable @typescript-eslint/no-explicit-any */
type J = any;

/**
 * Security inventory (tenancy, roles, secrets) over EVERY route the Hono app registers.
 *
 * Routes are enumerated from `app.routes`, not from a hand list, so a new route is covered
 * automatically. Route params are filled with real ids of Alice's data; an unknown param name fails
 * the suite until a fixture is added here (so nothing slips through with a dummy id).
 *
 * Guarantees checked:
 *  1. Non-members get 404 (never 403/2xx) on every workspace route, and see none of Alice's data.
 *  2. A member of another workspace can't reach Alice's entities by id through their own workspace.
 *  3. Viewers get 403 on every mutating route (justified exceptions listed in VIEWER_EXCEPTIONS).
 *  4. Editors can't perform external actions (publish, outreach send, account management, spend
 *     approval) without the separate grant.
 *  5. OAuth tokens / API keys never appear in any API response, log line, job payload or model trace,
 *     and are encrypted at rest.
 */

const SECRET_ACCESS = "ya29.ALICE_SECRET_ACCESS_TOKEN";
const SECRET_REFRESH = "1//ALICE_SECRET_REFRESH_TOKEN";
const RC_KEY = "sk_ALICE_SECRET_REVENUECAT_KEY";
const SECRETS = [SECRET_ACCESS, SECRET_REFRESH, RC_KEY];
/** Strings that only exist in Alice's workspace data. */
const ALICE_MARKERS = ["ALICE_PRIVATE", "AliceSecretApp", "alice-secret.example.com"];

const WS_PREFIX = "/v1/workspaces/:workspaceId";
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const REAL_ID_ROUTE_FLOOR = 149;

/**
 * Decision routes (`.../approve`, `.../reject`) an editor MAY call, because they decide content-level
 * work inside the workspace rather than an external action or spend (justify every entry). Any other
 * approve/reject route (e.g. a future autopilot checkpoint) must refuse editors, i.e. use the
 * approver capability for its action (growth APPROVER_CAP: spend → billing.manage, publish → publish…).
 */
const EDITOR_DECISIONS_ALLOWED = new Set([
  // Picking / discarding an AI concept for this campaign (content.write).
  "POST /v1/workspaces/:workspaceId/campaigns/:id/variants/:variantId/reject",
  // Discarding a proposed AI composition patch (content.write).
  "POST /v1/workspaces/:workspaceId/compositions/:id/patches/:patchId/reject",
]);

/**
 * Mutating workspace routes a viewer may call (justify every entry):
 * - POST /estimate is a read-only price calculation (no writes, no jobs): any status but 403.
 * - Operator routes (/admin/...) answer 404 to every non-operator, which hides them (stricter than 403).
 */
const VIEWER_EXCEPTIONS: Record<string, (status: number) => boolean> = {
  "POST /v1/workspaces/:workspaceId/estimate": (s) => s !== 403 && s < 500,
  "POST /v1/workspaces/:workspaceId/admin/workspaces/:targetId/plan": (s) => s === 404,
  "POST /v1/workspaces/:workspaceId/admin/workspaces/:targetId/credits": (s) => s === 404,
};

/** External actions that need a separate grant (or approver capability) beyond the editor role. */
const GRANT_GATED: string[] = [
  "POST /v1/workspaces/:workspaceId/posts/:id/publish",
  "POST /v1/workspaces/:workspaceId/posts/:id/mark-posted",
  "POST /v1/workspaces/:workspaceId/outreach/drafts/:id/send",
  "POST /v1/workspaces/:workspaceId/outreach/drafts/:id/copy",
  "POST /v1/workspaces/:workspaceId/outreach/drafts/:id/mark-sent",
  "POST /v1/workspaces/:workspaceId/outreach/drafts/:id/reset-send",
  "POST /v1/workspaces/:workspaceId/connections/:provider/start",
  "DELETE /v1/workspaces/:workspaceId/connections/:id",
  "POST /v1/workspaces/:workspaceId/apps/:appId/analytics/revenuecat",
  "DELETE /v1/workspaces/:workspaceId/analytics/connections/:id",
  "POST /v1/workspaces/:workspaceId/agent-runs/:runId/approve",
  "POST /v1/workspaces/:workspaceId/agent-runs/:runId/reject",
  "POST /v1/workspaces/:workspaceId/approvals/:id/approve",
  "POST /v1/workspaces/:workspaceId/approvals/:id/reject",
  "POST /v1/workspaces/:workspaceId/invites",
  "PATCH /v1/workspaces/:workspaceId/members/:uid",
  "DELETE /v1/workspaces/:workspaceId/members/:uid",
  "POST /v1/workspaces/:workspaceId/billing/upgrade-request",
];

/** Logger stand-in that keeps every line (incl. child bindings and serialised errors) for scanning. */
function captureLogger(out: string[]): Logger {
  const ser = (v: unknown) => {
    const seen = new WeakSet<object>();
    return JSON.stringify(v, (_k, val) => {
      if (val instanceof Error) return { ...(val as object), name: val.name, message: val.message, stack: val.stack, cause: (val as { cause?: unknown }).cause };
      if (val && typeof val === "object") {
        if (seen.has(val)) return "[circular]";
        seen.add(val);
      }
      return typeof val === "bigint" ? String(val) : val;
    });
  };
  const make = (bindings: object): Logger => {
    const l: Record<string, unknown> = { level: "trace", isLevelEnabled: () => true, child: (b: object) => make({ ...bindings, ...b }) };
    for (const m of ["trace", "debug", "info", "warn", "error", "fatal"]) l[m] = (...args: unknown[]) => void out.push(ser([m, bindings, ...args]));
    return l as unknown as Logger;
  };
  return make({});
}

function sampleDoc(): CompositionDoc {
  return {
    schemaVersion: 1,
    title: "ALICE_PRIVATE reel",
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#0A84FF" },
    scenes: [{ id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 3, layers: [{ id: "ly_hook", type: "text", role: "headline", text: "Stop losing mornings", box: { x: 0.1, y: 0.4, w: 0.8, h: 0.2 } }] }],
  } as unknown as CompositionDoc;
}

describe("security inventory: every route, every role", () => {
  const dir = mkdtempSync(join(tmpdir(), "muselaunch-sec-"));
  const cfg = loadConfig(
    {
      NODE_ENV: "test",
      AUTH_MODE: "dev",
      AUTH_DEV_TOKENS: "1",
      JOB_DISPATCH: "inline",
      DB_DRIVER: "memory",
      STORAGE_DRIVER: "local",
      LOCAL_STORAGE_DIR: join(dir, "storage"),
      API_PUBLIC_URL: "http://localhost:8080",
      PUBLIC_WEB_URL: "https://app.example.com",
      LOG_LEVEL: "trace",
      TRACE_MODEL_IO: "1",
      SIGNUP_CREDITS: "2000",
    } as NodeJS.ProcessEnv,
    { fresh: true },
  );
  const logLines: string[] = [];
  const db = new MemoryDb();
  const p = createPlatform({ cfg, db, log: captureLogger(logLines) });
  // Background work is out of scope here: every job type succeeds without side effects or charges.
  const noop: HandlerRegistry = Object.fromEntries(JOB_TYPES.map((t) => [t, async () => ({ creditsUsed: 0 })]));
  createRunner(p, noop, "security-worker");
  const app = buildApp(p);

  const responses: { who: string; method: string; url: string; status: number; text: string }[] = [];
  function client(uid: string | null) {
    const auth: Record<string, string> = uid ? { authorization: `Bearer dev:${uid}:${uid}@example.com` } : {};
    const send = async (method: string, url: string, body?: unknown) => {
      const res = await app.request(url, { method, headers: { ...auth, "content-type": "application/json" }, body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body ?? {}) });
      const text = await res.text();
      responses.push({ who: uid ?? "anon", method, url, status: res.status, text });
      let parsed: J = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      return { status: res.status, body: parsed, text, headers: res.headers };
    };
    return { send, get: (u: string) => send("GET", u), post: (u: string, b?: unknown) => send("POST", u, b), patch: (u: string, b: unknown) => send("PATCH", u, b) };
  }
  const alice = client("alice");
  const bob = client("bob");
  const vic = client("vic"); // viewer in Alice's workspace
  const eddie = client("eddie"); // editor in Alice's workspace (no publish/accounts grants)
  const anon = client(null);
  // Not a member anywhere. (Separate identities per phase also keep each under the API's per-user rate limit.)
  const mallory = client("mallory");

  let wsA = "";
  let wsB = "";
  const ids: Record<string, string> = {};

  /** Every distinct (method, path) the app serves, excluding middleware entries. */
  const routes = () => {
    const seen = new Map<string, { method: string; path: string }>();
    for (const r of app.routes) if (r.method !== "ALL") seen.set(`${r.method} ${r.path}`, { method: r.method, path: r.path });
    return [...seen.values()];
  };
  const wsRoutes = () => routes().filter((r) => r.path === WS_PREFIX || r.path.startsWith(`${WS_PREFIX}/`));
  const key = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

  /** First id of each workspace collection in Alice's workspace (filled after seeding). */
  const firstIdByCollection: Record<string, string> = {};
  /** Params that had to fall back to a placeholder id (reported, still checked for 404/403). */
  const unresolved = new Set<string>();
  const camel = (s: string) => s.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
  /**
   * Resolve a route param to a real id of Alice's data:
   *  1. explicit fixtures (`ids`), keyed `<segment>:id` / `<segment>:runId` or by param name;
   *  2. by convention for routes added later: `/<collection>/:id` (kebab or camel case) and
   *     `:<entity>Id` → the first document of that collection in Alice's workspace;
   *  3. otherwise a placeholder (recorded in `unresolved`; non-member and viewer checks still apply).
   */
  function resolveParam(name: string, prevSeg: string): string | undefined {
    const k = name === "id" || name === "runId" ? `${prevSeg}:${name}` : name;
    if (ids[k]) return ids[k];
    const candidates =
      name === "id"
        ? [camel(prevSeg)]
        : name.endsWith("Id")
          ? (() => {
              const base = name.slice(0, -2);
              return [`${base}s`, `${base}es`, base.replace(/y$/, "ies"), base.replace(/is$/, "es"), base];
            })()
          : [];
    for (const c of candidates) if (firstIdByCollection[c]) return firstIdByCollection[c];
    return undefined;
  }
  function fill(path: string, workspaceId: string, overrides: Record<string, string> = {}): string {
    const segs = path.split("/");
    return segs
      .map((s, i) => {
        if (!s.startsWith(":")) return s;
        const name = s.slice(1);
        if (name === "workspaceId") return workspaceId;
        const k = name === "id" || name === "runId" ? `${segs[i - 1]}:${name}` : name;
        let v = overrides[k] ?? resolveParam(name, segs[i - 1]!);
        if (!v) {
          unresolved.add(`${k} (${path})`);
          v = `zz_unresolved_${name}`;
        }
        return encodeURIComponent(v);
      })
      .join("/");
  }
  const entityParams = (path: string) => path.split("/").filter((s) => s.startsWith(":") && !["workspaceId", "provider", "v"].includes(s.slice(1)));

  beforeAll(async () => {
    wsA = (await alice.post("/v1/workspaces", { name: "Alice Apps" })).body.workspace.id;
    wsB = (await bob.post("/v1/workspaces", { name: "Bob Studio" })).body.workspace.id;
    await p.db.top("workspaces").update(wsA, { planId: "studio" }); // room for the extra members
    const A = `/v1/workspaces/${wsA}`;
    const ws = p.db.ws(wsA);
    const now = new Date().toISOString();

    for (const [uid, role] of [
      ["vic", "viewer"],
      ["eddie", "editor"],
    ] as const) {
      const inv = await alice.post(`${A}/invites`, { email: `${uid}@example.com`, role });
      expect(inv.status).toBe(201);
      expect((await client(uid).post(`/v1/invites/${inv.body.acceptUrl.split("/").pop()}/accept`)).status).toBe(200);
    }

    ids.appId = (await alice.post(`${A}/apps`, { name: "AliceSecretApp" })).body.app.id;
    const appId = ids.appId;
    expect((await alice.patch(`${A}/apps/${appId}`, { websiteUrl: "https://alice-secret.example.com" })).status).toBe(200);
    expect((await alice.patch(`${A}/apps/${appId}/dna`, { oneLiner: "ALICE_PRIVATE_ONELINER", description: "ALICE_PRIVATE positioning" })).status).toBe(200);
    ids.claimId = (await alice.post(`${A}/apps/${appId}/claims`, { text: "Syncs across devices" })).body.claim.id;
    ids.competitorId = (await alice.post(`${A}/apps/${appId}/competitors`, { name: "Rival" })).body.competitor.id;
    ids["competitors:id"] = ids.competitorId;
    ids["memory:id"] = (await alice.post(`${A}/apps/${appId}/memory`, { kind: "style", text: "ALICE_PRIVATE_MEMORY" })).body.preference.id;

    // Uploaded screenshot (signed PUT) + a ready video with a segmentation and a transcript.
    const up = await alice.post(`${A}/uploads`, { filename: "shot.png", mimeType: "image/png", bytes: 8, role: "screenshot", appId });
    expect(up.status).toBe(201);
    ids.assetId = up.body.asset.id;
    expect((await app.request(new URL(up.body.upload.url).pathname, { method: "PUT", headers: { "content-type": "image/png" }, body: "PNGDATA!" })).status).toBe(200);
    expect((await alice.post(`${A}/assets/${ids.assetId}/complete`)).status).toBe(200);
    const videoKey = workspaceKey(wsA, "uploads", "clip", "clip.mp4");
    await p.storage.put(videoKey, Buffer.from("0123456789ABCDEF"), { contentType: "video/mp4" });
    const video = await ws.collection("mediaAssets").create(
      { appId, kind: "video", role: "founder_clip", origin: "upload", storagePath: videoKey, mimeType: "video/mp4", bytes: 16, status: "ready", isProductTruth: false, durationSec: 5, title: "ALICE_PRIVATE clip" },
      { actor: "alice" },
    );
    ids["segmentations:id"] = (await ws.collection("segmentations").create({ appId, sourceAssetId: video.id, prompt: "phone", status: "succeeded", mediaType: "video" }, { actor: "alice" })).id;
    ids["transcripts:id"] = (await ws.collection("transcripts").create({ appId, sourceAssetId: video.id, purpose: "captions", status: "succeeded", text: "ALICE_PRIVATE_TRANSCRIPT" }, { actor: "alice" })).id;

    // Campaign, concept, composition + AI patch.
    const cpg = await alice.post(`${A}/apps/${appId}/campaigns`, { request: "ALICE_PRIVATE launch reels" });
    expect(cpg.status).toBe(202);
    ids.campaignId = cpg.body.campaign.id;
    ids["campaigns:id"] = ids.campaignId;
    ids.jobId = cpg.body.job.id;
    ids.variantId = (
      await ws.collection("campaignVariants").create(
        { appId, campaignId: ids.campaignId, title: "ALICE_PRIVATE concept", angleType: "practical_demo", hook: "h", audience: "a", keyMessage: "k", rationale: "r", hypothesis: "h", successMetric: { metric: "views" } },
        { actor: "alice" },
      )
    ).id;
    ids["compositions:id"] = (await createComposition(ws, { appId, campaignId: ids.campaignId, title: "ALICE_PRIVATE reel", doc: sampleDoc() }, "alice")).composition.id;
    const edit = await alice.post(`${A}/compositions/${ids["compositions:id"]}/ai-edit`, { baseVersion: 1, instruction: "Punchier", sceneIds: [] });
    expect(edit.status).toBe(202);
    ids.patchId = edit.body.patch.id;

    // Research + strategy runs.
    ids["research-runs:runId"] = (await alice.post(`${A}/apps/${appId}/research`, { kinds: ["trends"] })).body.researchRun.id;
    ids["agent-runs:runId"] = (await alice.post(`${A}/apps/${appId}/strategy`, { goal: "ALICE_PRIVATE growth goal" })).body.run.id;

    // Discover + CRM.
    ids["trackers:id"] = (await alice.post(`${A}/apps/${appId}/trackers`, { channel: "youtube", handle: "@rival", kind: "competitor" })).body.tracker.id;
    ids["prospects:id"] = (await alice.post(`${A}/apps/${appId}/prospects`, { channel: "youtube", handle: "creator1", url: "https://www.youtube.com/@creator1", niche: "study" })).body.prospect.id;
    ids["opportunities:id"] = (
      await ws.collection("opportunities").create(
        {
          appId,
          title: "ALICE_PRIVATE opportunity",
          topic: "t",
          audience: "a",
          whyRelevant: "w",
          proposedAngle: "p",
          confidence: 0.7,
          evidence: [{ kind: "search_result", url: "https://news.example.com/x", retrievedAt: now }],
          contentType: "short_video",
          effort: "low",
          observedAt: now,
          score: 70,
        },
        { actor: "agent:run1" },
      )
    ).id;
    ids["drafts:id"] = (await ws.collection("outreachDrafts").create({ appId, prospectId: ids["prospects:id"], channel: "email", body: "ALICE_PRIVATE_PITCH", status: "draft" }, { actor: "alice" })).id;

    // Publishing: a manual post with a pending publish approval.
    const post = await alice.post(`${A}/apps/${appId}/posts`, { campaignId: ids.campaignId, assetIds: [ids.assetId], channel: "reddit", caption: "ALICE_PRIVATE_CAPTION" });
    expect(post.status).toBe(201);
    ids["posts:id"] = post.body.post.id;
    const appr = await alice.post(`${A}/posts/${ids["posts:id"]}/request-approval`);
    expect(appr.status).toBe(200);
    ids["approvals:id"] = appr.body.approval.id;

    // Analytics.
    ids["links:id"] = (await alice.post(`${A}/campaigns/${ids.campaignId}/links`, { destination: "website", utm: { source: "s", medium: "m" } })).body.link.id;
    const obs = await alice.post(`${A}/apps/${appId}/observations`, { metric: "installs", value: 42, windowStart: "2026-10-01T00:00:00Z", windowEnd: "2026-10-02T00:00:00Z", definition: "ALICE_PRIVATE installs" });
    expect(obs.status).toBe(201);
    ids["observations:id"] = obs.body.observation.id;
    ids["imports:id"] = obs.body.batch.id;
    ids["experiments:id"] = (await alice.post(`${A}/apps/${appId}/experiments`, { title: "ALICE_PRIVATE test", hypothesis: "h", variants: [{ key: "a", label: "A" }], primaryMetric: "installs" })).body.experiment.id;
    ids["recommendations:id"] = (await ws.collection("recommendations").create({ appId, title: "ALICE_PRIVATE rec", rationale: "r", kind: "content", basedOn: {}, confidence: "low" }, { actor: "alice" })).id;

    // Connected accounts: OAuth tokens and a RevenueCat key, stored only via the encrypted SecretStore.
    const accId = "acc_alice_youtube";
    await p.secrets.put(wsA, `tok_${accId}`, "oauth_youtube", { accessToken: SECRET_ACCESS, refreshToken: SECRET_REFRESH, scope: ["https://www.googleapis.com/auth/youtube.upload"] });
    await ws.collection("connectedAccounts").create(
      { id: accId, appId, provider: "youtube", purposes: ["publishing"], externalAccountId: "UC_ALICE", displayName: "ALICE_PRIVATE channel", status: "connected", capabilities: ["publish_video"], secretId: `tok_${accId}`, connectedBy: "alice" },
      { actor: "alice" },
    );
    ids["connections:id"] = accId;
    const overview = JSON.parse(readFileSync(new URL("../../../fixtures/analytics/revenuecat-overview.json", import.meta.url), "utf8")).response;
    installRevenueCatFetch(p, (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const ok = new Headers(init?.headers).get("authorization") === `Bearer ${RC_KEY}`;
      const body = !ok ? { type: "authentication_error", message: "bad key" } : url.pathname.endsWith("/metrics/overview") ? overview : url.pathname === "/v2/projects" ? { items: [{ id: "proj_test", name: "Alice" }] } : { message: "nf" };
      return new Response(JSON.stringify(body), { status: ok ? 200 : 401, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch);
    const rc = await alice.post(`${A}/apps/${appId}/analytics/revenuecat`, { secretKey: RC_KEY, projectId: "proj_test" });
    expect(rc.status).toBe(201);

    // Phase-2 collections (routes land later; the convention-based resolver picks these up).
    const clipVideoId = (await ws.collection("transcripts").get(ids["transcripts:id"]!))!.sourceAssetId;
    await ws.collection("clipAnalyses").create(
      { appId, sourceAssetId: clipVideoId, status: "succeeded", prompts: ["person", "phone"], segmentationIds: { phone: ids["segmentations:id"]! }, transcriptId: ids["transcripts:id"] },
      { actor: "alice" },
    );
    // Module G routes are `/reviews/:id[/findings/:findingId/...]`: register real fixtures for them.
    ids["reviews:id"] = (
      await ws.collection("brandReviews").create(
        {
          appId,
          subject: { entity: "compositions", id: ids["compositions:id"]! },
          subjectVersion: 1,
          status: "warnings",
          reviewer: { engine: "rules" },
          summary: "ALICE_PRIVATE review",
          findings: [{ id: "bf_alice_private", severity: "warn", category: "tone", message: "ALICE_PRIVATE finding", source: "rules", suggestedOps: [{ op: "update_layer", sceneId: "sc_hook", layerId: "ly_hook", set: { text: "ALICE_PRIVATE fix" } }] }],
        },
        { actor: "alice" },
      )
    ).id;
    ids.findingId = "bf_alice_private";
    await ws.collection("autopilots").create({ appId, goal: "ALICE_PRIVATE autopilot goal", status: "paused", stage: "research", budget: { maxCredits: 100 } }, { actor: "alice" });

    ids.uid = "eddie";
    ids.provider = "youtube";
    ids.v = "1";
    ids.targetId = wsA;
    await p.inline!.drain();
    for (const name of Object.keys(ENTITY_SCHEMAS)) {
      const first = (await ws.collection(name as keyof typeof ENTITY_SCHEMAS).list({ limit: 1 })).items[0];
      if (first) firstIdByCollection[name] = first.id;
    }
  });

  it("mounts every workspace route behind the membership middleware", () => {
    const scoped = app.routes.filter((r) => r.method === "ALL" && r.path === `${WS_PREFIX}/*`);
    expect(scoped.some((r) => r.handler === workspaceScope)).toBe(true);
    expect(wsRoutes().length).toBeGreaterThan(150);
    // Every param of today's routes maps to real data; params of routes added later resolve by
    // collection convention, or fall back to a placeholder that is reported here.
    const withRealIds = wsRoutes().filter((r) => entityParams(r.path).length && !fill(r.path, wsA).includes("zz_unresolved_"));
    if (unresolved.size) console.warn(`security.test: route params without a real fixture (checked with placeholders):\n  ${[...unresolved].join("\n  ")}`);
    // Conventions that phase-2 routes are expected to use resolve to Alice's seeded documents.
    for (const [param, prev, coll] of [
      ["id", "autopilots", "autopilots"],
      ["autopilotId", "x", "autopilots"],
      ["id", "brand-reviews", "brandReviews"],
      ["brandReviewId", "x", "brandReviews"],
      ["id", "clip-analyses", "clipAnalyses"],
      ["clipAnalysisId", "x", "clipAnalyses"],
    ] as const) {
      expect(firstIdByCollection[coll], coll).toBeTruthy();
      expect(resolveParam(param, prev), `${prev}/:${param}`).toBe(firstIdByCollection[coll]);
    }
    // Floor = routes with entity params at review time (all resolved to Alice's real data then).
    expect(withRealIds.length).toBeGreaterThanOrEqual(REAL_ID_ROUTE_FLOOR);
  });

  it("rejects unauthenticated calls on every /v1 route except the public, self-validating ones", async () => {
    const PUBLIC = ["/v1/storage/local/", "/v1/oauth/"];
    for (const r of routes().filter((x) => x.path.startsWith("/v1/") && !PUBLIC.some((pfx) => x.path.startsWith(pfx)))) {
      const url = r.path.startsWith(WS_PREFIX) ? fill(r.path, wsA) : r.path.replace(/:[A-Za-z]+/g, "x");
      const res = await anon.send(r.method, url);
      expect(res.status, `${key(r)} without a token`).toBe(401);
    }
  });

  it("non-members get 404 (not 403) on every workspace route and see none of the workspace's data", async () => {
    const checked: string[] = [];
    for (const r of wsRoutes()) {
      const url = fill(r.path, wsA);
      const res = await mallory.send(r.method, url);
      expect(res.status, `non-member ${key(r)}`).toBe(404);
      expect(res.body?.error?.code, `non-member ${key(r)}`).toBe("NOT_FOUND");
      for (const m of ALICE_MARKERS) expect(res.text, `non-member ${key(r)} leaked ${m}`).not.toContain(m);
      checked.push(key(r));
    }
    expect(checked.length).toBe(wsRoutes().length);
  });

  it("a member of another workspace can't reach these entities by id through their own workspace", async () => {
    const aliceIds = Object.entries(ids)
      .filter(([k]) => !["uid", "provider", "v", "targetId"].includes(k))
      .map(([, v]) => v);
    for (const r of wsRoutes().filter((x) => entityParams(x.path).length)) {
      const url = fill(r.path, wsB, { uid: "alice" });
      const res = await bob.send(r.method, url);
      const label = `bob via own workspace: ${key(r)}`;
      expect(res.status, label).toBeGreaterThanOrEqual(400);
      if (r.method === "GET") expect(res.status, label).toBe(404);
      for (const m of ALICE_MARKERS) expect(res.text, `${label} leaked ${m}`).not.toContain(m);
      const leaked = aliceIds.filter((id) => !url.includes(encodeURIComponent(id)) && res.text.includes(id));
      expect(leaked, `${label} leaked ids`).toEqual([]);
    }
    // List/query endpoints filtered by Alice's ids return nothing of hers.
    const B = `/v1/workspaces/${wsB}`;
    for (const q of [
      `/assets?appId=${ids.appId}`,
      `/assets?campaignId=${ids.campaignId}`,
      `/jobs?appId=${ids.appId}`,
      `/compositions?appId=${ids.appId}`,
      `/compositions?campaignId=${ids.campaignId}`,
      `/approvals?appId=${ids.appId}`,
      `/usage?jobId=${ids.jobId}`,
      `/connections`,
      `/members`,
      `/billing/credits`,
    ]) {
      const res = await bob.get(`${B}${q}`);
      expect(res.status, q).toBe(200);
      for (const m of [...ALICE_MARKERS, ids.appId, ids.campaignId, ids.jobId, ids["connections:id"], "alice@example.com"]) expect(res.text, `${q} leaked ${m}`).not.toContain(m);
    }
  });

  it("viewers get 403 on every mutating workspace route (exceptions justified in VIEWER_EXCEPTIONS)", async () => {
    const mutating = wsRoutes().filter((r) => MUTATING.has(r.method));
    expect(mutating.length).toBeGreaterThan(90);
    for (const r of mutating) {
      const res = await vic.send(r.method, fill(r.path, wsA));
      const allowed = VIEWER_EXCEPTIONS[key(r)];
      if (allowed) expect(allowed(res.status), `viewer ${key(r)} → ${res.status}`).toBe(true);
      else expect(res.status, `viewer ${key(r)}`).toBe(403);
    }
    // Viewers can still read.
    expect((await vic.get(`/v1/workspaces/${wsA}/apps/${ids.appId}`)).status).toBe(200);
  });

  it("editors can't publish, send outreach, manage accounts/members or approve spend without the separate grant", async () => {
    const all = new Set(wsRoutes().map(key));
    for (const k of GRANT_GATED) {
      expect(all.has(k), `${k} is still a registered route`).toBe(true);
      const [method, path] = k.split(" ") as [string, string];
      const res = await eddie.send(method, fill(path, wsA));
      expect(res.status, `editor ${k}`).toBe(403);
    }
    // Every approve/reject decision route (including ones added later) refuses editors unless allowlisted.
    const decisions = wsRoutes().filter((r) => r.method === "POST" && /\/(approve|reject)$/.test(r.path) && !EDITOR_DECISIONS_ALLOWED.has(key(r)));
    expect(decisions.length).toBeGreaterThanOrEqual(5);
    for (const r of decisions) expect((await eddie.send(r.method, fill(r.path, wsA))).status, `editor ${key(r)}`).toBe(403);
    // ...while ordinary content work is allowed.
    expect((await eddie.post(`/v1/workspaces/${wsA}/apps/${ids.appId}/memory`, { kind: "style", text: "Editor note" })).status).toBe(201);
  });

  it("owner reads of every GET route never return server errors or secrets", async () => {
    for (const r of wsRoutes().filter((x) => x.method === "GET")) {
      const res = await alice.get(fill(r.path, wsA));
      expect(res.status, `alice ${key(r)}`).toBeLessThan(500);
    }
    const conns = await alice.get(`/v1/workspaces/${wsA}/connections`);
    expect(conns.body.items.find((a: J) => a.id === ids["connections:id"])).toMatchObject({ hasCredentials: true });
  });

  it("tokens and API keys never appear in responses, logs, job payloads or traces, and are encrypted at rest", async () => {
    await p.inline!.drain();
    expect(responses.length).toBeGreaterThan(500);
    for (const r of responses) for (const s of SECRETS) expect(r.text, `${r.who} ${r.method} ${r.url}`).not.toContain(s);
    expect(logLines.length).toBeGreaterThan(100);
    for (const line of logLines) for (const s of SECRETS) expect(line).not.toContain(s);
    // Signed storage URLs are bearer tokens too: access logs record the route, not the token.
    expect(logLines.some((l) => l.includes("/v1/storage/local/[token]"))).toBe(true);
    for (const line of logLines) expect(line).not.toMatch(/\/v1\/storage\/local\/[A-Za-z0-9_-]{20,}/);
    const jobs = (await p.db.ws(wsA).collection("jobs").list({ limit: 500 })).items;
    expect(jobs.length).toBeGreaterThan(3);
    for (const s of SECRETS) expect(JSON.stringify(jobs)).not.toContain(s);
    const events = (await p.db.ws(wsA).collection("jobEvents").list({ limit: 500 })).items;
    for (const s of SECRETS) expect(JSON.stringify(events)).not.toContain(s);
    const audit = (await p.db.ws(wsA).collection("auditLog").list({ limit: 500 })).items;
    for (const s of SECRETS) expect(JSON.stringify(audit)).not.toContain(s);
    const traceDir = join(dir, "storage", "workspaces", wsA, "traces");
    const traces = (() => {
      try {
        return readdirSync(traceDir, { recursive: true }).map(String);
      } catch {
        return [];
      }
    })();
    for (const f of traces.filter((x) => x.endsWith(".json"))) for (const s of SECRETS) expect(readFileSync(join(traceDir, f), "utf8")).not.toContain(s);
    // At rest: the secret documents hold ciphertext only, and decrypt back for the workspace that owns them.
    for (const docId of [`secret.tok_${ids["connections:id"]}`]) {
      const raw = JSON.stringify(db.readRaw(`workspaces/${wsA}/state`, docId));
      expect(raw).toContain('"iv"');
      for (const s of SECRETS) expect(raw).not.toContain(s);
    }
    const rcDocs = db.listRaw(`workspaces/${wsA}/state`).filter((d) => JSON.stringify(d).includes("revenuecat"));
    expect(rcDocs.length).toBeGreaterThan(0);
    for (const d of rcDocs) expect(JSON.stringify(d)).not.toContain(RC_KEY);
    expect(await p.secrets.get<{ accessToken: string }>(wsA, `tok_${ids["connections:id"]}`)).toMatchObject({ accessToken: SECRET_ACCESS });
    // AES-GCM is bound to the workspace (AAD): another tenant's id can't decrypt it.
    const row = db.readRaw(`workspaces/${wsA}/state`, `secret.tok_${ids["connections:id"]}`)!;
    db.writeRaw(`workspaces/${wsB}/state`, `secret.tok_${ids["connections:id"]}`, row);
    await expect(p.secrets.get(wsB, `tok_${ids["connections:id"]}`)).rejects.toThrow();
  });
});
