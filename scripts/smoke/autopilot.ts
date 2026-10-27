import { handlers as agentHandlers } from "@muselaunch/agents";
import { handlers as analyticsHandlers } from "@muselaunch/analytics";
import { autopilotDetail, cancelAutopilot, handlers as autopilotHandlers, installAutopilotHooks, startAutopilot } from "@muselaunch/autopilot";
import { createRunner, type Platform } from "@muselaunch/platform";
import { saveLive } from "./_save";

/**
 * Growth Autopilot live smoke (module B). OPT-IN, because it makes several real Meta calls
 * (≈ $0.2–0.6): `pnpm smoke:live autopilot` or SMOKE_AUTOPILOT=1.
 *  1. Imports a real App Store listing and builds App DNA with Muse Spark (app.import → app.analyze).
 *  2. Starts an autopilot whose budget covers research only: Muse Wonder researches with live web
 *     search (every finding cited), chooses the audience and sets a hypothesis (each a recorded
 *     decision run), then the loop pauses at the budget checkpoint before concepts.
 *  3. Prints the decisions + citations, then cancels. Redacted output: fixtures/live/autopilot-*.json.
 */
export async function run(p: Platform): Promise<string> {
  if (!process.argv.slice(2).includes("autopilot") && process.env.SMOKE_AUTOPILOT !== "1") return "skipped (opt-in: pnpm smoke:live autopilot)";
  if (!p.cfg.META_API_KEY) return "skipped (META_API_KEY not set)";
  createRunner(p, { ...agentHandlers, ...analyticsHandlers, ...autopilotHandlers }, "smoke-autopilot");
  installAutopilotHooks(p);
  const wid = "smoke_autopilot";
  await p.credits.ensureAccount(wid, { grant: 300, reason: "smoke" });
  const ws = p.db.ws(wid);
  const url = process.env.SMOKE_APP_STORE_URL ?? "https://apps.apple.com/us/app/forest-focus-for-productivity/id866450515";
  const app = await ws.collection("apps").create({ name: "New app", status: "importing", storeUrls: { ios: url } }, { actor: "smoke" });
  const imp = await ws.collection("appImports").create({ appId: app.id, sources: [{ kind: "app_store", url }], status: "queued" }, { actor: "smoke" });
  await p.jobs.create(wid, "app.import", { appId: app.id, importId: imp.id }, { actor: "smoke", credits: { operation: "app.import" } });
  await p.inline!.drain();
  if (!(await ws.collection("brandProfiles").get(app.id))) return "FAILED: App DNA was not created (see app.analyze job)";

  const research = p.credits.estimate("research.run", {}).credits;
  const { autopilot } = await startAutopilot(p, wid, app.id, { goal: "More installs from university students during exam season", maxCredits: research + 1, maxIterations: 1, autoApproveCredits: 0, variants: 2 }, "smoke");
  await p.inline!.drain();
  const d = await autopilotDetail(p, wid, autopilot.id);
  saveLive("autopilot-detail", d);
  const ap = d.autopilot;
  const usage = (await ws.collection("modelUsage").list({ limit: 200 })).items.filter((u) => u.appId === app.id);
  const cost = usage.reduce((n, u) => n + u.costUsdEstimate, 0);
  const cited = d.findings.filter((f) => f.evidence.some((e) => e.url && e.retrievedAt)).length;
  await cancelAutopilot(p, wid, ap.id, "smoke");
  return [
    `status=${ap.status} stage=${ap.stage} waiting="${d.waitingFor}"`,
    `findings cited=${cited}/${d.findings.length}`,
    `audience="${ap.audience?.description ?? "-"}"`,
    `hypothesis="${ap.hypothesis?.statement ?? "-"}"`,
    `decision runs=${d.runs.length} credits=${ap.spent.credits}/${ap.budget.maxCredits} model cost≈$${cost.toFixed(3)}`,
    ap.error ? `error=${ap.error.code}: ${ap.error.message}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
