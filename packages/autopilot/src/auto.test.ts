import { fixture, fixtureJson, installFakeWeb, jsonRoute, png, resolvePlaceholders } from "@muselaunch/agents/testing";
import { DEFAULT_AUTOPILOT_SETTINGS, type Autopilot, type WorkspaceMember } from "@muselaunch/contracts";
import { describe, expect, it } from "vitest";
import { autoRecommendOnNewData, needsYou, planAutoStart, startAutoAutopilot, tryStartAutoAutopilot } from "./index";
import { autopilotPlatform } from "./testing";

const IOS_URL = "https://apps.apple.com/us/app/tidy-timer-focus-pomodoro/id1234567890";
type Member = Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">;
const OWNER: Member = { role: "owner", canPublish: true, canManageAccounts: true, status: "active" };
const EDITOR: Member = { role: "editor", canPublish: false, canManageAccounts: false, status: "active" };

/** A fresh workspace (Autopilot settings at their defaults unless given) with an owner and an editor. */
async function setup(opts: { credits?: number; settings?: Partial<typeof DEFAULT_AUTOPILOT_SETTINGS> & { maxCreditsPerRun?: number }; failImport?: boolean } = {}) {
  const h = autopilotPlatform({ routes: [jsonRoute("AppDna", (req) => resolvePlaceholders(fixtureJson("spark-app-dna.json"), req))] });
  const { p } = h;
  const shot = await png([250, 250, 250]);
  const icon = await png([92, 70, 220], [64, 64], [255, 190, 0]);
  installFakeWeb(p, [
    { match: "https://itunes.apple.com/lookup?id=1234567890", contentType: "text/javascript", body: opts.failImport ? "not json" : fixture("itunes-lookup.json"), status: opts.failImport ? 500 : 200 },
    { match: /mzstatic\.com\/image\/thumb\/fixture\/icon/, contentType: "image/png", body: icon },
    { match: /mzstatic\.com\/image\/thumb\/fixture\/shot/, contentType: "image/png", body: shot },
  ]);
  const wid = `ws_auto_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  await p.db.top("workspaces").set(wid, {
    id: wid,
    workspaceId: wid,
    name: "Auto test",
    slug: `auto-${wid}`,
    ownerId: "u1",
    planId: "studio",
    spendCeilingUsd: 25,
    settings: { defaultTimezone: "UTC", defaultLocale: "en", metaDataMode: "standard", autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS, ...opts.settings } },
    createdAt: now,
    updatedAt: now,
    createdBy: "u1",
  });
  const ws = p.db.ws(wid);
  await ws.collection("members").create({ id: "u1", userId: "u1", role: "owner", canPublish: true, canManageAccounts: true, status: "active" }, { actor: "u1" });
  await ws.collection("members").create({ id: "u2", userId: "u2", role: "editor", status: "active" }, { actor: "u1" });
  await p.credits.ensureAccount(wid, { grant: opts.credits ?? 2000, reason: "test" });
  /** Same as POST /apps with a store link: the app, its import record and the app.import job. */
  const addApp = async () => {
    const app = await ws.collection("apps").create({ name: "New app", status: "importing", dnaStatus: "none", storeUrls: { ios: IOS_URL }, targetCountries: [] }, { actor: "u1" });
    const imp = await ws.collection("appImports").create({ appId: app.id, sources: [{ kind: "app_store", url: IOS_URL }], status: "queued" }, { actor: "u1" });
    const job = await p.jobs.create(wid, "app.import", { appId: app.id, importId: imp.id }, { actor: "u1", appId: app.id, idempotencyKey: `app.import:${imp.id}`, credits: { operation: "app.import" } });
    await ws.collection("appImports").update(imp.id, { jobId: job.id }, { actor: "u1" });
    return { appId: app.id, importJobId: job.id };
  };
  return { ...h, wid, ws, addApp };
}

describe("Autopilot by default (auto.ts)", () => {
  it("added app → the run waits for the import, accepts App DNA, sets the goal from it, renders within budget and stops at Needs you", async () => {
    const h = await setup();
    const { appId } = await h.addApp();
    // Started before App DNA exists: provisional goal, analysis credits held back for the import chain.
    const plan = await planAutoStart(h.p, h.wid, appId, { member: OWNER });
    expect(plan).toMatchObject({ goalFromDna: false, goal: "Get more installs of your app", variants: 2, maxIterations: 1, fits: true, setupCredits: 15 });
    expect(plan.maxCredits).toBeGreaterThanOrEqual(125);
    expect(plan.autoApproveCredits).toBe(Math.min(200, plan.maxCredits));
    const { autopilot } = await startAutoAutopilot(h.p, h.wid, appId, { member: OWNER, actor: "u1" });
    expect(autopilot.auto).toEqual({ goal: true, acceptDna: true });
    await h.p.inline!.drain();

    const ap = (await h.ws.collection("autopilots").getOrThrow(autopilot.id)) as Autopilot;
    expect(ap).toMatchObject({ status: "sleeping", stage: "measure", goal: "Get more installs of Tidy Timer from students", auto: { goal: false, acceptDna: true } });
    // It waited for the import (no second analysis) and accepted App DNA on the founder's behalf.
    expect(ap.log.find((e) => e.stage === "understand" && e.summary.startsWith("Accepted your App DNA automatically"))).toBeTruthy();
    expect(ap.log.some((e) => e.summary.startsWith("No App DNA yet"))).toBe(false);
    const analyses = (await h.ws.collection("jobs").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((j) => j.type === "app.analyze");
    expect(analyses).toHaveLength(1);
    const dna = await h.ws.collection("brandProfiles").getOrThrow(appId);
    expect(dna).toMatchObject({ status: "confirmed", confirmedBy: `agent:autopilot:${ap.id}` });
    expect(await h.ws.collection("apps").getOrThrow(appId)).toMatchObject({ dnaStatus: "confirmed", status: "ready" });
    // Renders went ahead inside the budget, without a spend checkpoint; nothing went over budget.
    expect(ap.log.some((e) => e.kind === "decision" && e.summary.startsWith("Final render auto-approved"))).toBe(true);
    expect(ap.log.some((e) => e.kind === "checkpoint" && /needs your OK|needs more credits/i.test(e.summary))).toBe(false);
    expect(ap.spent.credits).toBeLessThanOrEqual(ap.budget.maxCredits);
    expect(h.rendered).toHaveLength(2);

    // Needs you: exactly the two posts, decided through the publish approval route with the shown snapshot.
    const owner = await needsYou(h.p, h.wid, OWNER, { appId });
    expect(owner.count).toBe(2);
    for (const item of owner.items) {
      expect(item).toMatchObject({ kind: "post", action: "publish", canDecide: true, stale: false, requiredCap: "publish" });
      const approval = await h.ws.collection("approvals").getOrThrow(item.id);
      expect(item.approve).toEqual({ path: `/approvals/${item.id}/approve`, body: { snapshotHash: approval.snapshotHash } });
      expect(item.preview?.channel).toBeTruthy();
    }
    // Editors see what's waiting but can't decide publishing.
    expect((await needsYou(h.p, h.wid, EDITOR, { appId })).items.every((i) => !i.canDecide)).toBe(true);
    // Nothing was published.
    const posts = await h.ws.collection("scheduledPosts").getMany(ap.scheduledPostIds);
    expect(posts.every((x) => x.status === "awaiting_approval")).toBe(true);
  });

  it("says so when credits are short and offers a smaller run; a per-run limit picks fewer videos; editors don't pre-approve renders", async () => {
    // Budgets assume the longest automatic video (60 s): one variant fits in 180 credits, two don't.
    const h = await setup({ credits: 180 });
    const { appId } = await h.addApp();
    const plan = await planAutoStart(h.p, h.wid, appId, { member: OWNER });
    expect(plan.fits).toBe(false);
    expect(plan.shortfall).toMatchObject({ kind: "credits" });
    expect(plan.shortfall!.message).toMatch(/needs ≈\d+ credits and your workspace has \d+/);
    expect(plan.smaller).toMatchObject({ variants: 1 });
    // Nothing starts silently: the outcome explains and carries the offer.
    const out = await tryStartAutoAutopilot(h.p, h.wid, appId, { member: OWNER, actor: "u1" });
    expect(out).toMatchObject({ started: false, code: "insufficient_credits" });
    expect(out.reason).toMatch(/smaller run \(1 video/);
    expect((await h.ws.collection("autopilots").list({ limit: 10 })).items).toHaveLength(0);
    // The smaller run fits and starts.
    const small = await startAutoAutopilot(h.p, h.wid, appId, { variants: 1, member: OWNER, actor: "u1" });
    expect(small.autopilot.budget).toMatchObject({ variants: 1, maxCredits: plan.smaller!.maxCredits });
    // One active run per app.
    expect(await tryStartAutoAutopilot(h.p, h.wid, appId, { variants: 1, member: OWNER, actor: "u1" })).toMatchObject({ started: false, code: "already_running" });

    const limited = await setup({ settings: { maxCreditsPerRun: 150 } });
    const a2 = await limited.addApp();
    const p2 = await planAutoStart(limited.p, limited.wid, a2.appId, { member: OWNER });
    expect(p2).toMatchObject({ variants: 1, fits: true });
    expect(p2.notes.join(" ")).toMatch(/1 video instead of 2 to stay within your 150-credit limit/);
    const p3 = await planAutoStart(limited.p, limited.wid, a2.appId, { member: EDITOR });
    expect(p3.autoApproveCredits).toBe(0);
    expect(p3.notes.join(" ")).toMatch(/only members who manage billing/);
    expect(await tryStartAutoAutopilot(limited.p, limited.wid, a2.appId, { member: { ...EDITOR, role: "viewer" }, actor: "u3" })).toMatchObject({ started: false, code: "forbidden" });
  });

  it("an import that fails stops the run honestly (nothing invented)", async () => {
    const h = await setup({ failImport: true });
    const { appId } = await h.addApp();
    const { autopilot } = await startAutoAutopilot(h.p, h.wid, appId, { member: OWNER, actor: "u1" });
    await h.p.inline!.drain();
    const ap = await h.ws.collection("autopilots").getOrThrow(autopilot.id);
    expect(ap.status).toBe("failed");
    expect(ap.error?.userMessage).toMatch(/couldn't finish learning your app/);
    expect(await h.ws.collection("brandProfiles").get(appId)).toBeNull();
    expect(ap.researchRunId).toBeUndefined();
  });

  it("generates recommendations when new measured data arrives (Autopilot on), once per cooldown; never when off", async () => {
    const h = await setup();
    const { appId } = await h.addApp();
    const job = (over: Record<string, unknown> = {}) =>
      ({ id: `job_csv_${Math.random().toString(36).slice(2, 8)}`, type: "analytics.import_csv", status: "succeeded", appId, createdBy: "u1", output: { refs: [], data: { observationCount: 12 } }, ...over }) as never;
    const first = await autoRecommendOnNewData(h.p, h.wid, job());
    expect(first).toMatchObject({ type: "recommendations.generate", appId, createdBy: "u1" });
    expect(await autoRecommendOnNewData(h.p, h.wid, job())).toBeNull(); // cooling down
    const off = await setup({ settings: { enabled: false } });
    const a2 = await off.addApp();
    expect(await autoRecommendOnNewData(off.p, off.wid, { ...(job() as object), appId: a2.appId } as never)).toBeNull();
    // No new rows, or someone who can't run analytics: nothing.
    const fresh = await setup();
    const a3 = await fresh.addApp();
    expect(await autoRecommendOnNewData(fresh.p, fresh.wid, { ...(job({ output: { refs: [], data: { observationCount: 0 } } }) as object), appId: a3.appId } as never)).toBeNull();
    await fresh.ws.collection("members").create({ id: "v1", userId: "v1", role: "viewer", status: "active" }, { actor: "u1" });
    expect(await autoRecommendOnNewData(fresh.p, fresh.wid, { ...(job({ createdBy: "v1" }) as object), appId: a3.appId } as never)).toBeNull();
  });
});
