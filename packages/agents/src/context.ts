import type { App, BrandProfile, Claim, Competitor, MediaAsset } from "@muselaunch/contracts";
import { AppError } from "@muselaunch/platform";
import type { WorkspaceDb } from "@muselaunch/db";
import { clip } from "./util";

export interface AppContextData {
  app: App;
  dna: BrandProfile | null;
  verifiedClaims: Claim[];
  competitors: Competitor[];
}

export async function loadAppContext(ws: WorkspaceDb, appId: string): Promise<AppContextData> {
  const app = await ws.collection("apps").getOrThrow(appId);
  const [dna, claims, competitors] = await Promise.all([
    ws.collection("brandProfiles").get(appId),
    ws.collection("claims").list({ where: [["appId", "==", appId], ["state", "==", "verified"]], orderBy: { field: "createdAt", dir: "desc" }, limit: 100 }),
    ws.collection("competitors").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 }),
  ]);
  return { app, dna, verifiedClaims: claims.items, competitors: competitors.items };
}

export function requireDna(c: AppContextData): BrandProfile {
  if (!c.dna) throw new AppError("BAD_REQUEST", "App DNA has not been generated yet", { userMessage: "Build your App DNA first (import your listing or describe your app)." });
  return c.dna;
}

/** Compact App DNA text for prompts (ids included so the model can reference features/claims). */
export function dnaSummary(c: AppContextData, maxChars = 12_000): string {
  const d = c.dna;
  const lines: string[] = [`App: ${c.app.name}${c.app.platforms.length ? ` (${c.app.platforms.join(", ")})` : ""}${c.app.category ? ` · ${c.app.category}` : ""}`];
  if (d) {
    lines.push(`One-liner: ${d.oneLiner}`, `Description: ${clip(d.description, 1200)}`);
    if (d.features.length) lines.push("Features (id: name — description):", ...d.features.map((f) => `- ${f.id}: ${f.name} — ${clip(f.description, 200)}${f.assetIds.length ? ` [screenshots: ${f.assetIds.join(", ")}]` : ""}`));
    if (d.audiences.length) lines.push("Audiences:", ...d.audiences.map((a) => `- ${a.name}: ${clip(a.description, 200)}${a.painPoints.length ? ` | pains: ${a.painPoints.join("; ")}` : ""}`));
    if (d.problems.length) lines.push("Problems solved:", ...d.problems.map((x) => `- ${x.text}`));
    if (d.differentiators.length) lines.push("Differentiators:", ...d.differentiators.map((x) => `- ${x.text}`));
    lines.push(`Monetization: ${d.monetization.model}${d.monetization.notes ? ` (${d.monetization.notes})` : ""}`);
    if (d.tone.voice.length) lines.push(`Voice: ${d.tone.voice.join(", ")}${d.tone.vocabularyAvoid.length ? ` | avoid: ${d.tone.vocabularyAvoid.join(", ")}` : ""}`);
    if (d.preferredCtas.length) lines.push(`Preferred CTAs: ${d.preferredCtas.join(" | ")}`);
    if (d.visual.styleKeywords.length) lines.push(`Visual style: ${d.visual.styleKeywords.join(", ")}`);
    if (d.guidelines) lines.push(`Brand guidelines: ${clip(d.guidelines, 800)}`);
    if (d.prohibitedClaims.length) lines.push("Prohibited claims (never use):", ...d.prohibitedClaims.map((x) => `- ${x}`));
  }
  lines.push(
    "Verified claims (id: text) — the ONLY product claims marketing copy may make:",
    ...(c.verifiedClaims.length ? c.verifiedClaims.map((x) => `- ${x.id}: ${x.text}`) : ["- (none verified yet: avoid specific product claims beyond the feature list)"]),
  );
  if (c.competitors.length) lines.push("Known competitors:", ...c.competitors.map((x) => `- ${x.name}${x.websiteUrl ? ` (${x.websiteUrl})` : ""}${x.positioning ? `: ${clip(x.positioning, 160)}` : ""}`));
  return clip(lines.join("\n"), maxChars);
}

/** Real product media (screenshots/recordings/logos/founder clips) usable in storyboards. */
export async function productAssets(ws: WorkspaceDb, appId: string): Promise<MediaAsset[]> {
  const page = await ws.collection("mediaAssets").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  return page.items.filter((a) => a.status !== "deleted" && a.status !== "failed" && a.status !== "pending_upload" && !a.generation);
}
