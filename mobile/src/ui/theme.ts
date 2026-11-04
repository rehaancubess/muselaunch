/**
 * MuseLaunch's look on the phone: the web's neutral tokens (packages/ui/src/tokens.css). The accent
 * isn't here: it follows the open app (ui/accent.tsx, lib/app-theme.ts), monochrome by default.
 */
import { Platform, type TextStyle } from "react-native";

export const color = {
  canvas: "#ffffff",
  surface: "#ffffff",
  mist: "#f5f5f7",
  mist2: "#ececf0",
  ink: "#1d1d1f",
  ink2: "#6e6e73",
  ink3: "#a1a1a6",
  line: "#e8e8ed",
  lineStrong: "#d2d2d7",
  success: "#138a48",
  successSoft: "#e8f6ee",
  warning: "#9a5b00",
  warningSoft: "#fff4de",
  danger: "#d1243a",
  dangerSoft: "#fdecee",
  black: "#000000",
  white: "#ffffff",
};

export const radius = { sm: 8, md: 10, lg: 14, xl: 20, xxl: 28, full: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 28, gutter: 20 };

const family = Platform.select({ web: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', 'Segoe UI', system-ui, sans-serif", default: undefined });

export const type: Record<"title1" | "title2" | "title3" | "headline" | "body" | "bodySm" | "footnote" | "caption", TextStyle> = {
  title1: { fontFamily: family, fontSize: 30, lineHeight: 36, fontWeight: "700", letterSpacing: -0.4, color: color.ink },
  title2: { fontFamily: family, fontSize: 26, lineHeight: 32, fontWeight: "700", letterSpacing: -0.3, color: color.ink },
  title3: { fontFamily: family, fontSize: 20, lineHeight: 26, fontWeight: "600", letterSpacing: -0.2, color: color.ink },
  headline: { fontFamily: family, fontSize: 17, lineHeight: 22, fontWeight: "600", color: color.ink },
  body: { fontFamily: family, fontSize: 17, lineHeight: 24, color: color.ink },
  bodySm: { fontFamily: family, fontSize: 15, lineHeight: 21, color: color.ink },
  footnote: { fontFamily: family, fontSize: 13, lineHeight: 18, color: color.ink2 },
  caption: { fontFamily: family, fontSize: 12, lineHeight: 16, color: color.ink3 },
};

export const shadow = {
  raised: Platform.select({
    ios: { shadowColor: "#101828", shadowOpacity: 0.07, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } },
    android: { elevation: 2 },
    default: { boxShadow: "0 1px 2px rgba(16,24,40,0.04), 0 0 0 1px rgba(16,24,40,0.06), 0 8px 24px -12px rgba(16,24,40,0.12)" },
  }) as object,
  float: Platform.select({
    ios: { shadowColor: "#101828", shadowOpacity: 0.16, shadowRadius: 24, shadowOffset: { width: 0, height: 12 } },
    android: { elevation: 8 },
    default: { boxShadow: "0 18px 48px -12px rgba(16,24,40,0.18), 0 0 0 1px rgba(16,24,40,0.06)" },
  }) as object,
};
