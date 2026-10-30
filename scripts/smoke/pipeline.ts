import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { handlers as agentHandlers, installCampaignHooks } from "@muselaunch/agents";
import { handlers as analyticsHandlers, installAnalyticsHooks } from "@muselaunch/analytics";
import { autopilotDetail, handlers as autopilotHandlers, installAutopilotHooks, startAutopilot } from "@muselaunch/autopilot";
import { handlers as growthHandlers } from "@muselaunch/growth";
import { handlers as mediaHandlers, requestRecordingAnalysis } from "@muselaunch/media";
import { createRunner, type HandlerRegistry, type Platform } from "@muselaunch/platform";
import { handlers as renderHandlers } from "@muselaunch/render";
import { saveLive } from "./_save";

/**
 * Whole-product live run on this machine (OPT-IN: `pnpm smoke:live pipeline`, about $1–3 of model
 * spend and 10–20 minutes): import a real App Store app (default Magic Pocket; SMOKE_APP_STORE_URL),
 * App DNA, SAM screen cut-outs, optionally a walkthrough recording (SMOKE_WALKTHROUGH=path.mp4),
 * then a full Growth Autopilot iteration with 1 video: research, audience, hypothesis, concept,
 * storyboard, b-roll, build, Brand Guardian, final render (local HyperFrames), Spark video review,
 * post drafts. Outputs for a person to look at land in fixtures/live/pipeline/ (MP4s, cut-outs,
 * review frames, summary.json).
 */
export async function run(p: Platform): Promise<string> {
  if (!process.argv.slice(2).includes("pipeline")) return "skipped (opt-in: pnpm smoke:live pipeline)";
  if (!p.cfg.META_API_KEY) return "skipped (META_API_KEY not set)";
  const all = { ...agentHandlers, ...mediaHandlers, ...renderHandlers, ...growthHandlers, ...analyticsHandlers, ...autopilotHandlers } as HandlerRegistry;
  createRunner(p, all, "smoke-pipeline");
  installAnalyticsHooks(p);
  installCampaignHooks(p);
  installAutopilotHooks(p);
  const out = fileURLToPath(new URL("../../fixtures/live/pipeline/", import.meta.url));
  mkdirSync(out, { recursive: true });
  const wid = "smoke_pipeline";
  await p.credits.ensureAccount(wid, { grant: 2000, reason: "smoke" });
  const ws = p.db.ws(wid);
  const lines: string[] = [];
  const t0 = Date.now();
  const mins = () => `${((Date.now() - t0) / 60_000).toFixed(1)} min`;

  // 1. Import + App DNA (+ SAM cut-outs, queued after DNA).
  const url = process.env.SMOKE_APP_STORE_URL ?? "https://apps.apple.com/us/app/magic-pocket-save-find/id6809896477";
  const app = await ws.collection("apps").create({ name: "New app", status: "importing", storeUrls: { ios: url } }, { actor: "smoke" });
  const imp = await ws.collection("appImports").create({ appId: app.id, sources: [{ kind: "app_store", url }], status: "queued" }, { actor: "smoke" });
  await p.jobs.create(wid, "app.import", { appId: app.id, importId: imp.id }, { actor: "smoke", credits: { operation: "app.import" } });
  await p.inline!.drain();
  const dna = await ws.collection("brandProfiles").get(app.id);
  if (!dna) return "FAILED: App DNA was not created (see app.analyze job)";
  lines.push(`DNA "${dna.oneLiner}" features=${dna.features.length} (${mins()})`);

  const assets = (await ws.collection("mediaAssets").list({ where: [["appId", "==", app.id]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items;
  const shots = assets.filter((a) => a.role === "screenshot" && a.sourceLabel !== "sam_ui_crop");
  const crops = assets.filter((a) => a.sourceLabel === "sam_ui_crop");
  mkdirSync(`${out}crops`, { recursive: true });
  for (const c of crops) writeFileSync(`${out}crops/${c.id}.png`, await p.storage.get(c.storagePath));
  lines.push(`screenshots raw=${shots.filter((s) => s.screenshotKind === "raw_ui").length} marketing=${shots.filter((s) => s.screenshotKind === "marketing").length} unclassified=${shots.filter((s) => !s.screenshotKind).length} · SAM cut-outs=${crops.length}`);

  // 2. Optional walkthrough recording.
  const walk = process.env.SMOKE_WALKTHROUGH;
  if (walk) {
    const key = `workspaces/${wid}/apps/${app.id}/uploads/walkthrough.mp4`;
    const put = await p.storage.uploadFile(walk, key, { contentType: "video/mp4" });
    const rec = await ws.collection("mediaAssets").create(
      { appId: app.id, kind: "video", role: "app_recording", origin: "upload", storagePath: key, mimeType: "video/mp4", bytes: put.bytes, status: "uploaded", title: "Walkthrough", isProductTruth: true, license: { type: "user_uploaded" } },
      { actor: "smoke" },
    );
    await p.jobs.create(wid, "media.probe", { assetId: rec.id }, { actor: "smoke", appId: app.id });
    await p.inline!.drain();
    const probed = await ws.collection("mediaAssets").getOrThrow(rec.id);
    let segs = (await ws.collection("recordingSegments").list({ where: [["assetId", "==", rec.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 300 })).items;
    if (!segs.length) {
      await requestRecordingAnalysis(p, wid, { asset: probed, appId: app.id, actor: "smoke", consent: { scope: "smoke test narration" } });
      await p.inline!.drain();
      segs = (await ws.collection("recordingSegments").list({ where: [["assetId", "==", rec.id]], orderBy: { field: "startSec", dir: "asc" }, limit: 300 })).items;
    }
    saveLive("pipeline-segments", segs);
    lines.push(`walkthrough ${probed.durationSec?.toFixed(0)}s → ${segs.length} clips: ${segs.slice(0, 6).map((s) => `${s.startSec.toFixed(0)}-${s.endSec.toFixed(0)}s "${s.label}"`).join("; ")}`);
  }

  // 3. A full Autopilot iteration with one video.
  const { autopilot } = await startAutopilot(p, wid, app.id, { goal: process.env.SMOKE_GOAL ?? "Get more installs of the app from its best-fit audience", maxCredits: 900, maxIterations: 1, autoApproveCredits: 200, variants: 1 }, "smoke");
  await p.inline!.drain();
  const d = await autopilotDetail(p, wid, autopilot.id);
  saveLive("pipeline-autopilot", d);
  const ap = d.autopilot;
  lines.push(`autopilot status=${ap.status} stage=${ap.stage} waiting="${d.waitingFor ?? ""}" findings=${d.findings.length} credits=${ap.spent.credits} (${mins()})`);
  if (ap.error) lines.push(`error=${ap.error.code}: ${ap.error.message}`);

  // 4. What was made.
  for (const cid of ap.compositionIds) {
    const comp = await ws.collection("compositions").getOrThrow(cid);
    const versions = (await ws.collection("compositionVersions").list({ where: [["compositionId", "==", cid]], orderBy: { field: "version", dir: "desc" }, limit: 5 })).items;
    const doc = versions[0]?.doc;
    const templates = doc ? doc.scenes.map((s) => s.template ?? "?") : [];
    const dur = doc ? doc.scenes.reduce((n, s) => n + s.durationSec, 0) : 0;
    lines.push(`video "${comp.title}" v${comp.currentVersion} ${dur.toFixed(1)}s ${templates.length} scenes [${templates.join(", ")}] audio=${doc?.audio?.map((a) => a.kind).join("+") || "none"}`);
    const renders = (await ws.collection("mediaAssets").list({ where: [["appId", "==", app.id], ["role", "==", "render"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 20 })).items.filter((a) => a.render?.compositionId === cid);
    for (const r of renders) {
      const file = `${out}${comp.title.replace(/[^\w-]+/g, "-").slice(0, 40)}-v${r.render!.version}-${r.render!.quality}.mp4`;
      writeFileSync(file, await p.storage.get(r.storagePath));
      lines.push(`  render v${r.render!.version} ${r.render!.quality} ${r.durationSec?.toFixed(1) ?? "?"}s → ${file.split(/[\\/]/).slice(-3).join("/")}`);
    }
    const reviews = (await ws.collection("videoReviews").list({ where: [["compositionId", "==", cid]], orderBy: { field: "createdAt", dir: "desc" }, limit: 5 })).items;
    for (const rv of reviews) {
      const r = rv as unknown as { status: string; score?: number; summary?: string; findings?: { severity: string; issue: string; sceneId?: string }[]; version?: number };
      lines.push(`  Spark review v${r.version ?? "?"} ${r.status} score=${r.score ?? "-"}: ${(r.findings ?? []).map((f) => `[${f.severity}] ${f.issue}`).slice(0, 8).join(" | ")}`);
    }
  }
  const usage = (await ws.collection("modelUsage").list({ limit: 500 })).items;
  const byModel = new Map<string, number>();
  for (const u of usage) byModel.set(u.model, (byModel.get(u.model) ?? 0) + u.costUsdEstimate);
  lines.push(`model spend ≈ $${[...byModel.values()].reduce((a, b) => a + b, 0).toFixed(2)} (${[...byModel].map(([m, c]) => `${m} $${c.toFixed(2)}`).join(", ")}) total ${mins()}`);
  writeFileSync(`${out}summary.txt`, `${lines.join("\n")}\n`);
  return `\n  ${lines.join("\n  ")}`;
}
