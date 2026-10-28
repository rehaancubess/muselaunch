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

/** App import / analysis jobs for this app that haven't finished yet (App DNA is on its way). */
export async function dnaJobsInFlight(ws: WorkspaceDb, appId: string): Promise<Job[]> {
  const page = await ws.collection("jobs").list({ where: [["appId", "==", appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 });
  return page.items.filter((j) => (j.type === "app.import" || j.type === "app.analyze") && (j.status === "queued" || j.status === "running"));
}

