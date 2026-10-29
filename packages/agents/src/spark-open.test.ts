import { SPARK_OPEN_MODEL, type CompositionDoc } from "@muselaunch/contracts";
import { validateDoc } from "@muselaunch/compositions";
import { createComposition } from "@muselaunch/compositions/store";
import { createTestPlatform } from "@muselaunch/platform";
import { describe, expect, it } from "vitest";
import { handlers } from "./index";
import { fixtureJson, installFakeMeta, installFakeSparkOpen, jsonRoute, requestText, resolvePlaceholders, schemaName, seedApp, type MetaRoute } from "./testing";

/**
 * Muse Spark Open inside module B's jobs: routed post copy, a visible fallback in a scene edit, honest
 * labels on runs/patches, usage under the real provider, and per-workspace usage. Fake Meta and fake
 * Baseten serve labelled fixtures (documented shapes), never live output.
 */

const claimsOk = jsonRoute("ClaimValidation", (req) => ({ results: requestText(req).split("\n").filter((l) => l.startsWith('{"id":')).map((l) => ({ id: JSON.parse(l).id, issues: [] })) }));
const copyRoute = jsonRoute("CopyPacks", (req) => resolvePlaceholders(fixtureJson<{ repaired: unknown }>("spark-copy.json").repaired, req));
const editRoute = jsonRoute("CompositionEdit", () => fixtureJson<{ repaired: unknown }>("spark-edit.json").repaired);
/** Documented Meta 429 envelope; `retry-after-ms` keeps the SDK's own single retry fast. */
const rateLimited = (name: string): MetaRoute => (req) => (schemaName(req) === name ? new Response(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error", code: "rate_limit_exceeded" } }), { status: 429, headers: { "content-type": "application/json", "retry-after-ms": "1" } }) : undefined);

async function setup(opts: { meta: MetaRoute[]; open: MetaRoute[]; cfg?: Record<string, string>; workspaces?: string[] }) {
  const p = createTestPlatform({ META_API_KEY: "test-key", BASETEN_API_KEY: "test-baseten-key", ...opts.cfg }, handlers);
  const meta = installFakeMeta(p, [...opts.meta, claimsOk]);
  const open = installFakeSparkOpen(p, opts.open);
  const seeds: Record<string, Awaited<ReturnType<typeof seedApp>>> = {};
  for (const wid of opts.workspaces ?? ["ws_open"]) {
    await p.credits.ensureAccount(wid, { grant: 1000, reason: "test" });
    seeds[wid] = await seedApp(p, wid);
  }
  return { p, meta, open, seeds };
}

function doc(screenshotId: string): CompositionDoc {
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
      { id: "sc_demo", name: "Demo", template: "device-demo", purpose: "demo", durationSec: 5, layers: [{ id: "ly_demo_device", type: "device", screenAssetId: screenshotId, box: { x: 0.22, y: 0.26, w: 0.56, h: 0.58 } }] },
    ],
  });
  if (!v.ok) throw new Error(v.errors.join("\n"));
  return v.doc;
}

async function copyJob(s: Awaited<ReturnType<typeof setup>>, wid: string) {
  const ws = s.p.db.ws(wid);
  const campaign = await ws.collection("campaigns").create({ appId: s.seeds[wid]!.appId, name: "Exam season", goal: "installs", request: "Posts for students", channels: ["instagram"], deliverables: [{ kind: "short_video", aspectRatio: "9:16", durationSec: 15, count: 1 }] }, { actor: "u1" });
  return s.p.jobs.create(wid, "copy.generate", { appId: s.seeds[wid]!.appId, campaignId: campaign.id, channels: ["instagram", "producthunt"] }, { actor: "u1", credits: { operation: "copy.generate" } });
}

describe("Muse Spark Open in module B jobs", () => {
  it("copy.generate runs on Muse Spark Open by default (key set): run, step and usage name the real model; claims stay on Muse Spark", async () => {
    const s = await setup({ meta: [], open: [copyRoute] });
    const job = await copyJob(s, "ws_open");
    await s.p.inline!.drain();
    expect((await s.p.jobs.get("ws_open", job.id))?.status).toBe("succeeded");
    const ws = s.p.db.ws("ws_open");
    expect((await ws.collection("copyPacks").list()).items.map((x) => x.channel).sort()).toEqual(["instagram", "producthunt"]);
    expect(s.meta.requests.some((r) => schemaName(r) === "CopyPacks")).toBe(false);
    expect(s.open.requests[0]!.messages[0].content).toContain('<json_schema name="CopyPacks">');
    const run = (await ws.collection("agentRuns").list()).items.find((r) => r.kind === "copywriting")!;
    expect(run.model).toBe(SPARK_OPEN_MODEL);
    const steps = (await ws.collection("agentSteps").list({ where: [["runId", "==", run.id]] })).items;
    expect(steps.find((x) => x.kind === "model_call")).toMatchObject({ title: "Write channel copy (Muse Spark Open)", model: SPARK_OPEN_MODEL });
    const usage = (await ws.collection("modelUsage").list()).items;
    expect(usage.filter((u) => u.task === "copy.generate").map((u) => [u.provider, u.model, u.dataMode])).toEqual([["baseten", SPARK_OPEN_MODEL, "third_party"]]);
    expect(usage.filter((u) => u.task === "claims.validate").every((u) => u.provider === "meta")).toBe(true);
    expect(usage.every((u) => u.agentRunId === run.id)).toBe(true);
  });

  it("scene edit: Meta rate-limits → one visible fallback step, the patch is labelled with Muse Spark Open, usage shows both providers", async () => {
    const s = await setup({ meta: [rateLimited("CompositionEdit")], open: [editRoute] });
    const ws = s.p.db.ws("ws_open");
    const seed = s.seeds.ws_open!;
    const { composition } = await createComposition(ws, { appId: seed.appId, title: "One tap", doc: doc(seed.screenshotIds[0]!) }, "u1");
    const job = await s.p.jobs.create("ws_open", "composition.edit", { appId: seed.appId, compositionId: composition.id, baseVersion: 1, instruction: "Make the opening more engaging", sceneIds: ["sc_hook"], patchId: "pch_fallback", autoApply: true }, { actor: "u1", credits: { operation: "composition.edit" } });
    await s.p.inline!.drain();
    expect((await s.p.jobs.get("ws_open", job.id))?.status).toBe("succeeded");
    const patch = await ws.collection("compositionPatches").getOrThrow("pch_fallback");
    expect(patch).toMatchObject({ status: "applied", model: SPARK_OPEN_MODEL, modelNote: "Muse Spark was rate-limited; used Muse Spark Open (open weights) instead" });
    const run = await ws.collection("agentRuns").getOrThrow(patch.agentRunId!);
    expect(run.model).toBe("muse-spark-1.3"); // planned engine (scene edits default to Muse Spark)
    const steps = (await ws.collection("agentSteps").list({ where: [["runId", "==", run.id]], orderBy: { field: "index", dir: "asc" } })).items;
    const fallback = steps.find((x) => x.kind === "decision" && x.title.includes("rate-limited"));
    expect(fallback).toMatchObject({ title: "Muse Spark was rate-limited; used Muse Spark Open (open weights) instead", status: "succeeded", model: SPARK_OPEN_MODEL });
    const modelStep = steps.find((x) => x.kind === "model_call")!;
    expect(modelStep).toMatchObject({ title: "Propose scene-scoped patch (Muse Spark Open)", model: SPARK_OPEN_MODEL });
    expect(fallback!.index).toBeLessThan(modelStep.index);
    const edits = (await ws.collection("modelUsage").list({ orderBy: { field: "createdAt", dir: "asc" } })).items.filter((u) => u.task === "composition.edit");
    expect(edits.map((u) => [u.provider, u.status, u.errorCode ?? null])).toEqual([
      ["meta", "error", "RATE_LIMITED"],
      ["baseten", "ok", null],
    ]);
  });

  it("scene-scoped edits run on Muse Spark Open when opted in; the repair after a failed validation escalates to Muse Spark", async () => {
    const edit = fixtureJson<{ first: unknown; repaired: unknown }>("spark-edit.json");
    const s = await setup({ meta: [jsonRoute("CompositionEdit", () => edit.repaired)], open: [jsonRoute("CompositionEdit", () => edit.first)], cfg: { SPARK_OPEN_TASKS: "composition.edit.scoped" } });
    const ws = s.p.db.ws("ws_open");
    const seed = s.seeds.ws_open!;
    const { composition } = await createComposition(ws, { appId: seed.appId, title: "One tap", doc: doc(seed.screenshotIds[0]!) }, "u1");
    await s.p.jobs.create("ws_open", "composition.edit", { appId: seed.appId, compositionId: composition.id, baseVersion: 1, instruction: "Punchier opening", sceneIds: ["sc_hook"], patchId: "pch_optin", autoApply: true }, { actor: "u1" });
    await s.p.inline!.drain();
    const patch = await ws.collection("compositionPatches").getOrThrow("pch_optin");
    // Spark Open's first patch touched sc_cta (outside the scope) → rejected → Muse Spark repaired it.
    expect(patch).toMatchObject({ status: "applied", model: "muse-spark-1.3" });
    expect(patch.modelNote).toBeUndefined();
    const titles = (await ws.collection("agentSteps").list({ where: [["runId", "==", patch.agentRunId!]], orderBy: { field: "index", dir: "asc" } })).items.filter((x) => x.kind === "model_call").map((x) => x.title);
    expect(titles).toEqual(["Propose scene-scoped patch (Muse Spark Open)", "Repair patch (Muse Spark)"]);
  });

  it("usage and traces stay in the workspace that ran the job", async () => {
    const s = await setup({ meta: [], open: [copyRoute], workspaces: ["ws_a", "ws_b"] });
    await copyJob(s, "ws_a");
    await s.p.inline!.drain();
    const a = (await s.p.db.ws("ws_a").collection("modelUsage").list()).items;
    const b = (await s.p.db.ws("ws_b").collection("modelUsage").list()).items;
    expect(a.some((u) => u.provider === "baseten")).toBe(true);
    expect(b).toEqual([]);
    for (const u of a.filter((x) => x.provider === "baseten")) expect(u.traceAssetPath).toMatch(/^workspaces\/ws_a\/traces\//);
  });
});
