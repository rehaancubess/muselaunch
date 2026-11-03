import { handlers as agentHandlers } from "@muselaunch/agents";
import { handlers as analyticsHandlers } from "@muselaunch/analytics";
import { autopilotDetail, cancelAutopilot, handlers as autopilotHandlers, installAutopilotHooks, startAutopilot } from "@muselaunch/autopilot";
import { createRunner, type Platform } from "@muselaunch/platform";
import { saveLive } from "./_save";

/**
 * Muse Wonder as creative director, live. OPT-IN (several real Meta calls, ≈ $0.3–0.9):
 * `pnpm smoke:live direction` or `check-keys.cmd direction`.
 *  1. Imports a real App Store listing and builds App DNA with Muse Spark.
 *  2. Runs Growth Autopilot with a budget that covers research and video ideas only: Wonder researches
 *     (cited), picks the audience and hypothesis, Spark writes concepts, and Wonder picks AND directs
 *     the videos (pick_variants). The loop then pauses at the budget checkpoint before any storyboard
 *     or render, and is cancelled.
 *  3. Prints each picked video's direction and the model that wrote it. Redacted output:
 *     fixtures/live/direction-*.json.
 */
export async function run(p: Platform): Promise<string> {
  if (!process.argv.slice(2).some((a) => a.includes("direction")) && process.env.SMOKE_DIRECTION !== "1") return "skipped (opt-in: pnpm smoke:live direction)";
  if (!p.cfg.META_API_KEY) return "skipped (META_API_KEY not set)";
  createRunner(p, { ...agentHandlers, ...analyticsHandlers, ...autopilotHandlers }, "smoke-direction");
  installAutopilotHooks(p);
  const wid = "smoke_direction";
  await p.credits.ensureAccount(wid, { grant: 300, reason: "smoke" });
  const ws = p.db.ws(wid);
  const url = process.env.SMOKE_APP_STORE_URL ?? "https://apps.apple.com/us/app/forest-focus-for-productivity/id866450515";
  const app = await ws.collection("apps").create({ name: "New app", status: "importing", storeUrls: { ios: url } }, { actor: "smoke" });
  const imp = await ws.collection("appImports").create({ appId: app.id, sources: [{ kind: "app_store", url }], status: "queued" }, { actor: "smoke" });
  await p.jobs.create(wid, "app.import", { appId: app.id, importId: imp.id }, { actor: "smoke", credits: { operation: "app.import" } });
  await p.inline!.drain();
  if (!(await ws.collection("brandProfiles").get(app.id))) return "FAILED: App DNA was not created (see app.analyze job)";

  // Research + video ideas; the storyboards (next) don't fit, so the loop stops right after Wonder directs.
  const budget = p.credits.estimate("research.run", {}).credits + p.credits.estimate("campaign.generate_concepts", {}).credits + 1;
  const { autopilot } = await startAutopilot(p, wid, app.id, { goal: "More installs from university students during exam season", maxCredits: budget, maxIterations: 1, autoApproveCredits: 0, variants: 2 }, "smoke");
  await p.inline!.drain();
  const d = await autopilotDetail(p, wid, autopilot.id);
  const ap = d.autopilot;
  const variants = ap.variantIds.length ? await ws.collection("campaignVariants").getMany(ap.variantIds) : [];
  saveLive("direction-detail", { autopilot: ap, variants: variants.map((v) => ({ id: v.id, title: v.title, angleType: v.angleType, hook: v.hook, creativeDirection: v.creativeDirection })) });
  const usage = (await ws.collection("modelUsage").list({ limit: 300 })).items.filter((u) => u.appId === app.id);
  const cost = usage.reduce((n, u) => n + u.costUsdEstimate, 0);
  await cancelAutopilot(p, wid, ap.id, "smoke");

  const directed = variants.filter((v) => v.creativeDirection);
  const lines = directed.map((v) => {
    const c = v.creativeDirection!;
    return `  “${v.title}” (${v.angleType}) by ${c.model}: ${c.pacing} · ${c.musicMood} · shots ${c.signatureShots.join("+")} · motif: ${c.visualMotif} · hook: ${c.hookApproach}`;
  });
  const ok = variants.length > 0 && directed.length === variants.length && directed.every((v) => v.creativeDirection!.model.startsWith("muse-wonder"));
  const summary = [
    `${ok ? "Wonder directed" : "NOT DIRECTED"} ${directed.length}/${variants.length} video(s)`,
    `status=${ap.status} stage=${ap.stage} waiting="${d.waitingFor}"`,
    `credits=${ap.spent.credits}/${ap.budget.maxCredits} model cost≈$${cost.toFixed(3)}`,
    ap.error ? `error=${ap.error.code}: ${ap.error.message}` : "",
    lines.length ? `\n${lines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!ok) throw new Error(summary);
  return summary;
}
