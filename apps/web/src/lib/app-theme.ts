"use client";
import { themeTokens, type App, type ThemeTokens } from "@muselaunch/contracts";
import { useEffect, useLayoutEffect } from "react";

/**
 * The interface takes the current app's colour (monochrome until an app has one). Tokens are set on
 * <html>, so sheets and dialogs rendered in portals match too. The last app's colour is cached per
 * workspace so a reload doesn't flash monochrome first.
 */
const VARS: [Exclude<keyof ThemeTokens, "color">, string][] = [
  ["accent", "--ml-accent"],
  ["accentHover", "--ml-accent-hover"],
  ["accentSoft", "--ml-accent-soft"],
  ["accentInk", "--ml-accent-ink"],
  ["gradient", "--ml-brand-gradient"],
  ["focus", "--ml-focus"],
];

export function applyAppTheme(color: string | null | undefined): void {
  if (typeof document === "undefined") return;
  const t = themeTokens(color);
  const root = document.documentElement;
  for (const [key, prop] of VARS) {
    if (t.color) root.style.setProperty(prop, t[key]);
    else root.style.removeProperty(prop);
  }
  if (t.color) root.dataset.appColor = t.color;
  else delete root.dataset.appColor;
}

const lastAppKey = (ws: string) => `ml.lastApp.${ws}`;
const colorKey = (ws: string) => `ml.appColor.${ws}`;
const read = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const write = (k: string, v: string | null) => {
  try {
    if (v) localStorage.setItem(k, v);
    else localStorage.removeItem(k);
  } catch {
    /* storage unavailable: no cache, no harm */
  }
};

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Which app colours the interface: the app in the URL, else the last one opened here, else the first. */
export function themeAppFor(apps: App[], appId: string | undefined, lastAppId: string | null): App | undefined {
  if (appId) return apps.find((a) => a.id === appId);
  return apps.find((a) => a.id === lastAppId) ?? apps[0];
}

export function useAppTheme(workspaceId: string, appId: string | undefined, apps: App[], loaded: boolean): void {
  useIsoLayoutEffect(() => {
    applyAppTheme(read(colorKey(workspaceId)));
    return () => applyAppTheme(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!loaded) return;
    if (appId) write(lastAppKey(workspaceId), appId);
    const color = themeAppFor(apps, appId, read(lastAppKey(workspaceId)))?.theme?.color ?? null;
    applyAppTheme(color);
    write(colorKey(workspaceId), color);
  }, [workspaceId, appId, apps, loaded]);
}
