/** Defaults shared by the automatic start and the loop (no imports from stages, to avoid cycles). */
import { DEFAULT_AUTOPILOT_SETTINGS, type App, type BrandProfile, type Job, type Workspace, type WorkspaceAutopilotSettings } from "@muselaunch/contracts";
import type { WorkspaceDb } from "@muselaunch/db";

/** The workspace's Autopilot settings with defaults filled (on, renders pre-approved). */
export function autopilotSettings(workspace: Pick<Workspace, "settings"> | null | undefined): WorkspaceAutopilotSettings {
  return { ...DEFAULT_AUTOPILOT_SETTINGS, ...(workspace?.settings?.autopilot ?? {}) };
}

const lowerFirst = (s: string) => (s.length > 1 && /^[A-Z][a-z]/.test(s) ? s[0]!.toLowerCase() + s.slice(1) : s);

/**
 * "Get more installs of <App> from <top App DNA audience>". Without App DNA the goal is provisional
 * (`fromDna: false`) and the loop refines it once the app has been analysed.
 */
export function defaultGoal(app: Pick<App, "name" | "storeUrls">, dna: Pick<BrandProfile, "audiences"> | null): { goal: string; fromDna: boolean } {
  // Store names often carry a keyword subtitle ("Tidy Timer: Focus & Pomodoro"); the goal uses the brand part.
  const full = app.name && app.name !== "New app" ? app.name.trim() : "";
  const short = full.split(/\s*[:|–—]\s+|\s+-\s+/)[0]!.trim();
  const name = short.length >= 2 ? short : full || "your app";
  const audience = dna?.audiences[0]?.name?.trim();
  const who = audience ? ` from ${lowerFirst(audience)}` : "";
  const store = Boolean(app.storeUrls.ios || app.storeUrls.android);
  return { goal: (store ? `Get more installs of ${name}${who}` : `Get more people to try ${name}${who}`).slice(0, 1000), fromDna: Boolean(dna) };
}

/**
 * Screenshot checks still running for this app (`media.extract_ui`, queued after App DNA: raw app UI
 * vs designed store image, and SAM 3.1 cut-outs of the real screen). Storyboards choose screenshots
 * by that kind, so videos wait for it instead of framing a store image inside a device.
 */
export async function screenJobsInFlight(ws: WorkspaceDb, appId: string): Promise<Job[]> {
  const page = await ws.collection("jobs").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  // Screenshot checks, and walkthrough recordings still being cut into labelled clips: the video
  // plans should use that real footage, so they wait for it.
  return page.items.filter((j) => (j.type === "media.extract_ui" || j.type === "media.analyze_recording") && (j.status === "queued" || j.status === "running"));
}

/** App import / analysis jobs for this app that haven't finished yet (App DNA is on its way). */
export async function dnaJobsInFlight(ws: WorkspaceDb, appId: string): Promise<Job[]> {
  const page = await ws.collection("jobs").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  return page.items.filter((j) => (j.type === "app.import" || j.type === "app.analyze") && (j.status === "queued" || j.status === "running"));
}


/**
 * Whether the app has real product media a video plan can show: a screenshot or a screen recording
 * marked as product truth. A website-only app (a TV game, say) can have none until the founder adds some.
 */
export async function hasRealAppMedia(ws: WorkspaceDb, appId: string): Promise<boolean> {
  const m = await realAppMedia(ws, appId);
  return m.screenshots + m.recordings > 0;
}

/** Counts of that real product media: screenshots (incl. SAM cut-outs) and screen recordings. */
export async function realAppMedia(ws: WorkspaceDb, appId: string): Promise<{ screenshots: number; recordings: number }> {
  const page = await ws.collection("mediaAssets").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 });
  const real = page.items.filter((a) => a.isProductTruth && (a.status === "ready" || a.status === "uploaded" || a.status === "processing"));
  return { screenshots: real.filter((a) => a.role === "screenshot").length, recordings: real.filter((a) => a.role === "app_recording").length };
}
