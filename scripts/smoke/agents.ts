import { handlers, retrieveMemory, rememberPreference } from "@muselaunch/agents";
import { createRunner, safeFetch, type Platform } from "@muselaunch/platform";
import { glimmerClient } from "@muselaunch/providers";
import { saveLive } from "./_save";

/**
 * Module B live smoke (minimal REAL calls; run on a machine with network + keys):
 *  1. Public iTunes Lookup for a well-known app (no key needed) → full app.import (listing,
 *     icon + screenshots into local storage, evidence).
 *  2. If META_API_KEY is set: app.analyze → one Muse Spark multimodal App DNA extraction
 *     (≈ $0.02–0.05) validated against our schema; prints features/claims and cost.
 *  3. If GLIMMER_BASE_URL is set: /v1/models ping + one Glimmer memory selection.
 * Override the app with SMOKE_APP_STORE_URL. Redacted outputs land in fixtures/live/agents-*.json.
 */
export async function run(p: Platform): Promise<string> {
  const url = process.env.SMOKE_APP_STORE_URL ?? "https://apps.apple.com/us/app/duolingo-language-lessons/id570060128";
  const id = url.match(/\/id(\d+)/)?.[1];
  const parts: string[] = [];

  // 1. Raw lookup (saved for parser development), then the real import job.
  const raw = await safeFetch(`https://itunes.apple.com/lookup?id=${id}&country=us&entity=software`, { maxBytes: 3 * 1024 * 1024 });
  saveLive("agents-itunes-lookup", JSON.parse(raw.text()));
  createRunner(p, handlers, "smoke-agents");
  const wid = "smoke";
  await p.credits.ensureAccount(wid, { grant: 200, reason: "smoke" });
  const ws = p.db.ws(wid);
  const app = await ws.collection("apps").create({ name: "New app", status: "importing", storeUrls: { ios: url } }, { actor: "smoke" });
  const imp = await ws.collection("appImports").create({ appId: app.id, sources: [{ kind: "app_store", url }], status: "queued" }, { actor: "smoke" });
  await p.jobs.create(wid, "app.import", { appId: app.id, importId: imp.id }, { actor: "smoke", credits: { operation: "app.import" } });
  await p.inline!.drain();
  const imported = await ws.collection("appImports").getOrThrow(imp.id);
  const assets = (await ws.collection("mediaAssets").list({ where: [["appId", "==", app.id]], limit: 50 })).items;
  const evidence = (await ws.collection("appEvidence").list({ where: [["appId", "==", app.id]], limit: 200 })).items;
  parts.push(`import=${imported.status} name="${imported.listings[0]?.name}" assets=${assets.length} evidence=${evidence.length}${imported.warnings.length ? ` warnings=${imported.warnings.length}` : ""}`);

  // 2. Muse Spark App DNA (only with a key; otherwise the analyze job fails honestly).
  const jobs = (await ws.collection("jobs").list({ where: [["appId", "==", app.id]], limit: 10 })).items;
  const analyze = jobs.find((j) => j.type === "app.analyze");
  if (!p.cfg.META_API_KEY) {
    parts.push(`dna=skipped (META_API_KEY not set; analyze job ${analyze?.status} ${analyze?.error?.code ?? ""})`);
  } else {
    const dna = await ws.collection("brandProfiles").get(app.id);
    const claims = (await ws.collection("claims").list({ where: [["appId", "==", app.id]], limit: 50 })).items;
    const usage = (await ws.collection("modelUsage").list({ limit: 50 })).items.filter((u) => u.appId === app.id);
    saveLive("agents-app-dna", { dna, claims, usage });
    if (!dna) parts.push(`dna=FAILED ${analyze?.error?.code}: ${analyze?.error?.message}`);
    else {
      const cost = usage.reduce((n, u) => n + u.costUsdEstimate, 0);
      parts.push(
        `dna="${dna.oneLiner}" features=${dna.features.length} (${dna.features.map((f) => `${f.name}[ev ${f.evidenceIds.length}, shots ${f.assetIds.length}]`).join("; ")}) claims=${claims.length} verified=${claims.filter((c) => c.state === "verified").length} palette=${dna.visual.palette.map((c) => `${c.role}:${c.hex}`).join(",")} cost=$${cost.toFixed(4)}`,
      );
    }
  }

  // 3. Glimmer.
  const g = glimmerClient(p);
  if (g.configured) {
    const models = await g.models();
    await rememberPreference(p, { workspaceId: wid, appId: app.id, kind: "tone", text: "Keep the voice calm and encouraging; never say hustle", source: { type: "explicit" }, actor: "smoke" });
    await rememberPreference(p, { workspaceId: wid, appId: app.id, kind: "style", text: "Large, minimal on-screen text", source: { type: "explicit" }, actor: "smoke" });
    const mem = await retrieveMemory(p, { workspaceId: wid, appId: app.id, task: "copywriting", query: "Write an Instagram caption" });
    saveLive("agents-glimmer-memory", { models, mem });
    parts.push(`glimmer models=[${models.join(", ")}] usedGlimmer=${mem.usedGlimmer} selected=${mem.items.length}`);
  } else {
    parts.push("glimmer=skipped (GLIMMER_BASE_URL not set)");
  }
  return parts.join(" | ");
}
