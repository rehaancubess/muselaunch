import type { CompositionDoc } from "@muselaunch/contracts";
import { sceneHash, validateDoc } from "@muselaunch/compositions";
import { createComposition, getVersion } from "@muselaunch/compositions/store";
import { createTestPlatform, type JobContext } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { decideStrategy, handlers, rememberPreference, retrieveMemory } from "./index";
import {
  fixtureJson,
  installFakeGlimmer,
  installFakeMeta,
  jsonRoute,
  requestText,
  resolvePlaceholders,
  schemaName,
  searchRoute,
  seedApp,
  textRoute,
  toolNames,
  wonderRoute,
  type MetaRequest,
  type MetaRoute,
} from "./testing";

/** Claim validator fixture: flags any text containing "#1"; everything else passes (deterministic checks still run). */
const claimRoute = jsonRoute("ClaimValidation", (req) => {
  const lines = requestText(req).split("\n").filter((l) => l.startsWith('{"id":'));
  return { results: lines.map((l) => JSON.parse(l) as { id: string; text: string }).map((t) => ({ id: t.id, issues: t.text.includes("#1") ? [`"#1" is not supported by evidence`] : [] })) };
});

/** Sequence of structured responses for one schema name (first, then repaired...). */
function seqRoute(name: string, bodies: unknown[]): MetaRoute & { calls: number } {
  const r = ((req: MetaRequest) => {
    if (schemaName(req) !== name) return undefined;
    const body = bodies[Math.min(r.calls, bodies.length - 1)];
    r.calls++;
    return { ...(jsonRoute(name, () => resolvePlaceholders(body, req))(req, 0) as object) };
  }) as unknown as MetaRoute & { calls: number };
  r.calls = 0;
  return r;
}

async function setup(routes: MetaRoute[] = []) {
  const built: { storyboardId: string; compositionId: string }[] = [];
  const p = createTestPlatform({ META_API_KEY: "test-key" }, {
    ...handlers,
    // Module C's composition.build is not on this branch: a stub records the hand-off.
    "composition.build": async (ctx: JobContext<"composition.build">) => {
      built.push({ storyboardId: ctx.payload.storyboardId, compositionId: ctx.payload.compositionId });
      return { creditsUsed: 0 };
    },
  });
  const wid = "ws_campaign";
  await p.credits.ensureAccount(wid, { grant: 1000, reason: "test" });
  const seed = await seedApp(p, wid);
  const meta = installFakeMeta(p, [...routes, claimRoute]);
  return { p, wid, ws: p.db.ws(wid), seed, meta, built };
}

async function newCampaign(s: Awaited<ReturnType<typeof setup>>) {
  const campaign = await s.ws.collection("campaigns").create({ appId: s.seed.appId, name: "Exam season", goal: "installs", request: "Create three Reels for students using my real app", channels: ["instagram", "tiktok"], deliverables: [{ kind: "short_video", aspectRatio: "9:16", durationSec: 15, count: 3 }] }, { actor: "u1" });
  return campaign.id;
}

describe("campaign.generate_concepts", () => {
  it("creates a brief and ≥3 strategically distinct concepts grounded in verified claims + memory", async () => {
    const concepts = seqRoute("CampaignConcepts", [fixtureJson("spark-concepts.json")]);
    const s = await setup([concepts]);
    const pref = await rememberPreference(s.p, { workspaceId: s.wid, appId: s.seed.appId, kind: "angle_rejected", text: "Rejected concept: hustle-culture productivity angle", source: { type: "rejection" }, actor: "u1" });
    const campaignId = await newCampaign(s);
    const job = await s.p.jobs.create(s.wid, "campaign.generate_concepts", { appId: s.seed.appId, campaignId, count: 3 }, { actor: "u1", credits: { operation: "campaign.generate_concepts" } });
    await s.p.inline!.drain();
    expect((await s.p.jobs.get(s.wid, job.id))?.status).toBe("succeeded");
    const variants = (await s.ws.collection("campaignVariants").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" } })).items;
    expect(variants).toHaveLength(3);
    expect(new Set(variants.map((v) => v.angleType)).size).toBe(3);
    for (const v of variants) expect(v.claimIds.every((c) => s.seed.claimIds.verified.includes(c))).toBe(true);
    expect(variants.some((v) => v.memoryRefs.includes(pref.id))).toBe(true);
    const campaign = await s.ws.collection("campaigns").getOrThrow(campaignId);
    expect(campaign.status).toBe("concepts_ready");
    const brief = await s.ws.collection("campaignBriefs").getOrThrow(campaign.briefId!);
    expect(brief).toMatchObject({ version: 1, goal: "installs", channels: ["instagram", "tiktok"], cta: "Start your first focus session" });
    expect(brief.deliverables[0]).toMatchObject({ kind: "short_video", count: 3 });
    expect(brief.approvedClaimIds.every((c) => s.seed.claimIds.verified.includes(c))).toBe(true);
    // The rejected angle was in the prompt (memory applied), and no social_proof was offered (no real proof evidence).
    const req = s.meta.requests.find((r) => schemaName(r) === "CampaignConcepts")!;
    expect(requestText(req)).toContain("hustle-culture");
    expect(requestText(req)).not.toMatch(/Allowed angle types:[^\n]*social_proof/);
  });

  it("repairs concepts that share an angle, then saves distinct ones", async () => {
    const concepts = seqRoute("CampaignConcepts", [fixtureJson("spark-concepts-duplicate.json"), fixtureJson("spark-concepts.json")]);
    const s = await setup([concepts]);
    const campaignId = await newCampaign(s);
    await s.p.jobs.create(s.wid, "campaign.generate_concepts", { appId: s.seed.appId, campaignId, count: 3 }, { actor: "u1", credits: { operation: "campaign.generate_concepts" } });
    await s.p.inline!.drain();
    expect(concepts.calls).toBe(2);
    const repairReq = s.meta.requests.filter((r) => schemaName(r) === "CampaignConcepts")[1]!;
    expect(requestText(repairReq)).toContain('share angleType "practical_demo"');
    const variants = (await s.ws.collection("campaignVariants").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" } })).items;
    expect(new Set(variants.map((v) => v.angleType)).size).toBe(3);
  });

  it("fails (credits released) when concepts are still not distinct after one repair", async () => {
    const dup = fixtureJson("spark-concepts-duplicate.json");
    const s = await setup([seqRoute("CampaignConcepts", [dup, dup])]);
    const campaignId = await newCampaign(s);
    const job = await s.p.jobs.create(s.wid, "campaign.generate_concepts", { appId: s.seed.appId, campaignId, count: 3 }, { actor: "u1", credits: { operation: "campaign.generate_concepts" }, maxAttempts: 1 });
    await s.p.inline!.drain();
    const done = await s.p.jobs.get(s.wid, job.id);
    expect(done?.status).toBe("failed");
    expect((await s.p.credits.balance(s.wid)).reserved).toBe(0);
    expect((await s.ws.collection("campaignVariants").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" } })).items).toHaveLength(0);
  });
});

describe("storyboard.generate", () => {
  it("uses only allowlisted templates and real screenshots for demo scenes, repairs UI-depicting generated media, and enqueues composition.build", async () => {
    const concepts = seqRoute("CampaignConcepts", [fixtureJson("spark-concepts.json")]);
    const sb = seqRoute("Storyboard", [fixtureJson("spark-storyboard.json"), fixtureJson("spark-storyboard-repaired.json")]);
    const s = await setup([concepts, sb]);
    const campaignId = await newCampaign(s);
    await s.p.jobs.create(s.wid, "campaign.generate_concepts", { appId: s.seed.appId, campaignId, count: 3 }, { actor: "u1", credits: { operation: "campaign.generate_concepts" } });
    await s.p.inline!.drain();
    const variant = (await s.ws.collection("campaignVariants").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" } })).items.find((v) => v.angleType === "practical_demo")!;
    const job = await s.p.jobs.create(s.wid, "storyboard.generate", { appId: s.seed.appId, campaignId, variantId: variant.id, aspectRatio: "9:16", targetDurationSec: 15 }, { actor: "u1", credits: { operation: "storyboard.generate" } });
    await s.p.inline!.drain();
    const done = await s.p.jobs.get(s.wid, job.id);
    expect(done?.status).toBe("succeeded");
    expect(sb.calls).toBe(2); // UI-depicting generated image → one repair
    const updated = await s.ws.collection("campaignVariants").getOrThrow(variant.id);
    const story = await s.ws.collection("storyboards").getOrThrow(updated.storyboardId!);
    expect(story.scenes.map((x) => x.template)).toEqual(["hook-title", "device-demo", "feature-callout", "cta-endcard"]);
    expect(story.scenes.reduce((n, x) => n + x.durationSec, 0)).toBeCloseTo(15, 5);
    for (const scene of story.scenes.filter((x) => x.purpose === "demo" || x.purpose === "feature")) {
      const real = scene.assets.filter((h) => h.kind === "screenshot");
      expect(real.length).toBeGreaterThan(0);
      for (const h of real) expect(s.seed.screenshotIds).toContain(h.assetId);
    }
    expect(story.scenes[3]!.assets).toEqual([]); // invented logo id dropped
    expect(story.scenes[2]!.assets.some((h) => h.kind === "stock_image" && !/screenshot|interface/i.test(h.query ?? ""))).toBe(true);
    expect(story.scenes[2]!.claimIds.every((c) => s.seed.claimIds.verified.includes(c))).toBe(true);
    expect(s.built).toEqual([{ storyboardId: story.id, compositionId: (done!.output!.data as { compositionId: string }).compositionId }]);
    expect(updated.compositionIds).toContain(s.built[0]!.compositionId);
    expect((await s.ws.collection("campaigns").getOrThrow(campaignId)).status).toBe("producing");
    // Scene text went through the claim validator
    expect(s.meta.requests.some((r) => schemaName(r) === "ClaimValidation")).toBe(true);
  });
});

function testDoc(screenshotId: string): CompositionDoc {
  const v = validateDoc({
    schemaVersion: 1,
    title: "One tap to deep work",
    kind: "video",
    aspectRatio: "9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    theme: { mode: "light", background: "#F5F5F7", surface: "#FFFFFF", text: "#1D1D1F", textMuted: "#6E6E73", accent: "#5C46DC" },
    scenes: [
      { id: "sc_hook", name: "Hook", template: "hook-title", purpose: "hook", durationSec: 3, layers: [{ id: "ly_hook_title", type: "text", role: "headline", text: "One tap. No distractions.", box: { x: 0.08, y: 0.38, w: 0.84, h: 0.2 } }] },
      {
        id: "sc_demo",
        name: "Demo",
        template: "device-demo",
        purpose: "demo",
        durationSec: 5,
        layers: [
          { id: "ly_demo_head", type: "text", role: "headline", text: "Start a 25-minute session", box: { x: 0.08, y: 0.1, w: 0.84, h: 0.12 } },
          { id: "ly_demo_device", type: "device", screenAssetId: screenshotId, box: { x: 0.22, y: 0.26, w: 0.56, h: 0.58 } },
        ],
      },
      { id: "sc_cta", name: "CTA", template: "cta-endcard", purpose: "cta", durationSec: 3, layers: [{ id: "ly_cta_text", type: "text", role: "cta", text: "Start your first focus session", box: { x: 0.1, y: 0.45, w: 0.8, h: 0.1 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

describe("composition.edit", () => {
  it("produces a valid scene-scoped patch (others byte-identical), auto-applies it as a new version and remembers the instruction", async () => {
    const edit = fixtureJson<{ first: unknown; repaired: unknown }>("spark-edit.json");
    const route = seqRoute("CompositionEdit", [edit.first, edit.repaired]);
    const s = await setup([route]);
    const { composition } = await createComposition(s.ws, { appId: s.seed.appId, title: "One tap", doc: testDoc(s.seed.screenshotIds[0]!) }, "u1");
    const job = await s.p.jobs.create(s.wid, "composition.edit", { appId: s.seed.appId, compositionId: composition.id, baseVersion: 1, instruction: "Make the opening more engaging", sceneIds: ["sc_hook"], patchId: "pch_test_1", autoApply: true }, { actor: "u1", credits: { operation: "composition.edit" } });
    await s.p.inline!.drain();
    const done = await s.p.jobs.get(s.wid, job.id);
    expect(done?.status).toBe("succeeded");
    expect(route.calls).toBe(2); // first attempt touched sc_cta → rejected → one repair
    const firstReq = s.meta.requests.find((r) => schemaName(r) === "CompositionEdit")!;
    expect(requestText(firstReq)).toContain("layer id=ly_hook_title"); // describeForLLM used
    expect(requestText(firstReq)).toContain("Edit ONLY these scenes: sc_hook");
    const patch = await s.ws.collection("compositionPatches").getOrThrow("pch_test_1");
    expect(patch).toMatchObject({ status: "applied", resultVersion: 2, source: "ai", affectedSceneIds: ["sc_hook"], instruction: "Make the opening more engaging" });
    expect(patch.ops).toHaveLength(1);
    const v1 = await getVersion(s.ws, composition.id, 1);
    const v2 = await getVersion(s.ws, composition.id, 2);
    expect(v2.source).toBe("ai_edit");
    expect(v2.doc.scenes[0]!.layers[0]).toMatchObject({ text: "Where did your focus go?", animation: { enter: { preset: "pop" } } });
    for (const i of [1, 2]) expect(sceneHash(v2.doc.scenes[i]!)).toBe(sceneHash(v1.doc.scenes[i]!));
    const prefs = (await s.ws.collection("brandPreferences").list({ where: [["active", "==", true]], orderBy: { field: "createdAt", dir: "desc" } })).items;
    expect(prefs.find((x) => x.kind === "edit_instruction")?.text).toBe("Make the opening more engaging");
  });

  it("without autoApply leaves the patch proposed and the composition unchanged; invalid twice → job fails, nothing committed", async () => {
    const edit = fixtureJson<{ first: unknown; repaired: unknown }>("spark-edit.json");
    const s = await setup([seqRoute("CompositionEdit", [edit.repaired])]);
    const { composition } = await createComposition(s.ws, { appId: s.seed.appId, title: "One tap", doc: testDoc(s.seed.screenshotIds[0]!) }, "u1");
    await s.p.jobs.create(s.wid, "composition.edit", { appId: s.seed.appId, compositionId: composition.id, baseVersion: 1, instruction: "Punchier opening", sceneIds: ["sc_hook"], patchId: "pch_test_2" }, { actor: "u1" });
    await s.p.inline!.drain();
    expect((await s.ws.collection("compositionPatches").getOrThrow("pch_test_2")).status).toBe("proposed");
    expect((await s.ws.collection("compositions").getOrThrow(composition.id)).currentVersion).toBe(1);

    const bad = await setup([seqRoute("CompositionEdit", [edit.first, edit.first])]);
    const c2 = await createComposition(bad.ws, { appId: bad.seed.appId, title: "x", doc: testDoc(bad.seed.screenshotIds[0]!) }, "u1");
    const job = await bad.p.jobs.create(bad.wid, "composition.edit", { appId: bad.seed.appId, compositionId: c2.composition.id, baseVersion: 1, instruction: "Change only the hook", sceneIds: ["sc_hook"], patchId: "pch_bad", autoApply: true }, { actor: "u1" });
    await bad.p.inline!.drain();
    const failed = await bad.p.jobs.get(bad.wid, job.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error?.message).toMatch(/outside the requested scenes/);
    expect((await bad.ws.collection("compositions").getOrThrow(c2.composition.id)).latestVersion).toBe(1);
  });
});

describe("copy.generate", () => {
  it("writes channel-native packs, repairs limits once and records claim-validation issues honestly", async () => {
    const copy = fixtureJson<{ first: unknown; repaired: unknown }>("spark-copy.json");
    const route = seqRoute("CopyPacks", [copy.first, copy.repaired]);
    const s = await setup([route]);
    const campaignId = await newCampaign(s);
    const job = await s.p.jobs.create(s.wid, "copy.generate", { appId: s.seed.appId, campaignId, channels: ["instagram", "producthunt"] }, { actor: "u1", credits: { operation: "copy.generate" } });
    await s.p.inline!.drain();
    expect((await s.p.jobs.get(s.wid, job.id))?.status).toBe("succeeded");
    expect(route.calls).toBe(2);
    const packs = (await s.ws.collection("copyPacks").list({ where: [["campaignId", "==", campaignId]], orderBy: { field: "createdAt", dir: "desc" } })).items;
    const ig = packs.find((x) => x.channel === "instagram")!;
    const ph = packs.find((x) => x.channel === "producthunt")!;
    expect(ig.validation?.ok).toBe(true);
    expect(ig.items[0]!.claimIds).toHaveLength(1);
    expect(s.seed.claimIds.verified).toContain(ig.items[0]!.claimIds[0]);
    expect(ph.items.find((i) => i.kind === "product_hunt_tagline")!.text.length).toBeLessThanOrEqual(60);
    expect(ph.validation?.ok).toBe(false);
    expect(ph.validation?.issues[0]!.issue).toMatch(/1,000,000/);
  });
});

describe("strategy.run", () => {
  it("plans with Muse Wonder, proposes spend-related follow-ups behind an approval, and enqueues them only after approval", async () => {
    const strategy = wonderRoute(fixtureJson<{ turns: { name: string; args: unknown }[][] }>("wonder-strategy-turns.json").turns, (r) => toolNames(r).includes("set_strategy"));
    const research = wonderRoute([[{ name: "finish", args: { summary: "nothing new" } }]], (r) => toolNames(r).includes("save_finding"));
    const s = await setup([strategy, research, searchRoute(), seqRoute("CampaignConcepts", [fixtureJson("spark-concepts.json")]), textRoute("Summarise these research findings", "x")]);
    const run = await s.ws.collection("agentRuns").create({ appId: s.seed.appId, kind: "growth_strategy", model: "muse-wonder-1.0", status: "queued", goal: "Get students to install before exams", budget: { maxSearchCalls: 3, maxToolCalls: 12 } }, { actor: "u1" });
    await s.p.jobs.create(s.wid, "strategy.run", { appId: s.seed.appId, agentRunId: run.id, goal: run.goal }, { actor: "u1", credits: { operation: "strategy.run" } });
    await s.p.inline!.drain();
    const paused = await s.ws.collection("agentRuns").getOrThrow(run.id);
    expect(paused.status).toBe("needs_approval");
    expect(paused.plan?.hypotheses).toHaveLength(1);
    expect(paused.plan?.tasks.filter((t) => t.proposedAction).map((t) => t.proposedAction!.type)).toEqual(["research.run", "campaign.generate_concepts"]);
    const approval = await s.ws.collection("approvals").getOrThrow(paused.pendingApprovalId!);
    expect(approval).toMatchObject({ action: "spend", status: "pending", estimate: { credits: 55 } });
    // Nothing was enqueued before approval
    expect((await s.ws.collection("researchRuns").list({ where: [["appId", "==", s.seed.appId]], orderBy: { field: "createdAt", dir: "desc" } })).items).toHaveLength(0);

    const { run: decided, jobs } = await decideStrategy(s.p, { workspaceId: s.wid, runId: run.id, actor: "u1", approve: true });
    expect(decided.status).toBe("succeeded");
    expect(jobs.map((j) => j.type)).toEqual(["research.run", "campaign.generate_concepts"]);
    await s.p.inline!.drain();
    for (const j of jobs) expect((await s.p.jobs.get(s.wid, j.id))?.status).toBe("succeeded");
    expect((await s.ws.collection("approvals").getOrThrow(approval.id)).status).toBe("consumed");
    await expect(decideStrategy(s.p, { workspaceId: s.wid, runId: run.id, actor: "u1", approve: true })).rejects.toMatchObject({ code: "CONFLICT" });
  });
});

describe("Glimmer memory", () => {
  it("uses Glimmer to select relevant memory when configured, deterministic ranking otherwise (honestly flagged)", async () => {
    const s = await setup();
    const a = await rememberPreference(s.p, { workspaceId: s.wid, appId: s.seed.appId, kind: "style", text: "Keep text large and minimal", source: { type: "explicit" }, actor: "u1" });
    await rememberPreference(s.p, { workspaceId: s.wid, appId: s.seed.appId, kind: "tone", text: "Never say hustle", source: { type: "explicit" }, actor: "u1" });
    const again = await rememberPreference(s.p, { workspaceId: s.wid, appId: s.seed.appId, kind: "style", text: "Keep text LARGE and minimal!", source: { type: "explicit" }, actor: "u1" });
    expect(again.id).toBe(a.id); // deduplicated, strengthened
    expect(again.weight).toBeGreaterThan(a.weight);
    await rememberPreference(s.p, { workspaceId: "ws_elsewhere", kind: "style", text: "Other tenant preference", source: { type: "explicit" }, actor: "x" });

    const plain = await retrieveMemory(s.p, { workspaceId: s.wid, appId: s.seed.appId, task: "scene_edit", query: "make the text larger" });
    expect(plain.usedGlimmer).toBe(false);
    expect(plain.items[0]!.id).toBe(a.id);
    expect(plain.items.some((x) => x.text.includes("Other tenant"))).toBe(false);

    const g = installFakeGlimmer(s.p, (messages) => {
      const id = messages[1]!.content.match(/"id":"(prf_[a-f0-9]+)","kind":"tone"/)![1];
      return JSON.stringify({ selectedIds: [id, "prf_invented"], summary: "- Avoid the word hustle." });
    });
    const viaGlimmer = await retrieveMemory(s.p, { workspaceId: s.wid, appId: s.seed.appId, task: "copywriting", query: "caption" });
    expect(viaGlimmer.usedGlimmer).toBe(true);
    expect(viaGlimmer.items.map((x) => x.kind)).toEqual(["tone"]); // invented id ignored
    expect(viaGlimmer.summary).toContain("hustle");
    expect(g.requests[0]!.chat_template_kwargs).toEqual({ reasoning_strength: "low" });
    expect(g.requests[0]!.messages[1].content).not.toContain("Other tenant");
    const usage = (await s.ws.collection("modelUsage").list({ limit: 50 })).items.filter((u) => u.provider === "glimmer");
    expect(usage[0]).toMatchObject({ dataMode: "self_hosted", costUsdEstimate: 0, task: "memory.retrieve.copywriting" });

    installFakeGlimmer(s.p, () => "I think you should use the tone one.");
    const fallback = await retrieveMemory(s.p, { workspaceId: s.wid, appId: s.seed.appId, task: "copywriting", query: "caption" });
    expect(fallback.usedGlimmer).toBe(false);
    expect(fallback.items.length).toBeGreaterThan(0);
  });
});
