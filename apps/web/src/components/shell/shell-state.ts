import type { PrimaryTab } from "../../lib/routes";

/**
 * Which tab an app page belongs to (plain TS, tested in shell-state.test.ts):
 *  - Home: home (and the app root, which redirects there);
 *  - Create: create, Creator's deep pages (make, videos, scheduled, studio, campaigns, new; library and
 *    calendar redirect there) and Discover (its old page redirects to Create; See everything stays);
 *  - Results: results and Insights (its old page redirects to Results; Details stays);
 *  - no tab: About your app (brand), runs, Autopilot, Settings, Needs you, adding an app.
 */
const TAB_OF: Record<string, PrimaryTab> = {
  home: "home",
  create: "create",
  creator: "create",
  discover: "create",
  library: "create",
  calendar: "create",
  results: "results",
  insights: "results",
};

export interface ShellState {
  tab: PrimaryTab | null;
  /** The page's own name when it has no tab (e.g. "brand", "settings", "needs-you"). */
  section?: string;
  /** The Studio fills the window. */
  fullBleed: boolean;
}

export function shellStateFor(pathname: string): ShellState {
  const seg = pathname.split("/").filter(Boolean); // w, wid, a, appId, section, ...
  if (seg[2] === "a") {
    const s = seg[4] ?? "home";
    const tab = TAB_OF[s] ?? null;
    return { tab, section: tab ? undefined : s, fullBleed: s === "creator" && seg[5] === "studio" };
  }
  if (seg[2] === "settings") return { tab: null, section: seg[3] ?? "settings", fullBleed: false };
  return { tab: null, section: seg[2], fullBleed: false };
}
