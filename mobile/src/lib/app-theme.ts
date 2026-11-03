/**
 * The interface colour follows the app: an app's `theme.color` (picked from its icon by App DNA, or
 * set by the person on About your app on the web) drives the accents. No colour → monochrome
 * (graphite). The phone only reads it.
 *
 * The shades come from `themeTokens(color)` in packages/contracts/src/theme.ts (WCAG AA on white).
 * Until that lands here, every app gets monochrome: keep `themeFor` the one place this is decided.
 */
import type { App } from "../api/types";

export interface Accent {
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentInk: string;
  /** The logo's gradient (light → base → dark). */
  gradient: readonly [string, string, string];
}

export const MONOCHROME: Accent = {
  accent: "#1d1d1f",
  accentHover: "#000000",
  accentSoft: "#f0f0f2",
  accentInk: "#1d1d1f",
  gradient: ["#5a5a60", "#1d1d1f", "#000000"],
};

export function themeFor(_app: Pick<App, "theme"> | null | undefined): Accent {
  return MONOCHROME;
}
