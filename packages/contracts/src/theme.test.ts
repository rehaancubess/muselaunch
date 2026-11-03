import { describe, expect, it } from "vitest";
import { MONOCHROME_THEME, contrastRatio, isThemeable, pickThemeColor, themeTokens } from "./theme";

describe("app theme colour (theme.ts)", () => {
  it("is monochrome without a colour, or for greys, near-black and near-white", () => {
    for (const c of [null, undefined, "", "nope", "#000000", "#ffffff", "#808080", "#1d1d1f", "#f9f9fb"]) expect(themeTokens(c)).toEqual(MONOCHROME_THEME);
    expect(contrastRatio(MONOCHROME_THEME.accent, "#ffffff")).toBeGreaterThan(15);
  });

  it("keeps every pairing at WCAG AA for any hue and lightness", () => {
    for (let h = 0; h < 360; h += 15)
      for (const l of [20, 35, 50, 65, 80])
        for (const s of [40, 75, 100]) {
          const hex = hsl(h, s, l);
          const t = themeTokens(hex);
          if (!t.color) continue;
          expect(contrastRatio(t.accent, "#ffffff"), `${hex} accent on white`).toBeGreaterThanOrEqual(4.8);
          expect(contrastRatio(t.accent, t.accentSoft), `${hex} accent on soft`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(t.accentInk, t.accentSoft), `${hex} ink on soft`).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(t.accentHover, "#ffffff"), `${hex} hover on white`).toBeGreaterThanOrEqual(4.8);
        }
  });

  it("keeps an already-dark brand colour as it is and only darkens light ones", () => {
    expect(themeTokens("#5b21b6").accent).toBe("#5b21b6");
    const yellow = themeTokens("#FFD60A");
    expect(yellow.color).toBe("#ffd60a");
    expect(yellow.accent).not.toBe("#ffd60a");
    expect(contrastRatio(yellow.accent, "#ffffff")).toBeGreaterThanOrEqual(4.8);
  });

  it("picks the icon's colour first and skips grey ones", () => {
    expect(pickThemeColor([{ hex: "#111111", role: "primary" }, { hex: "#E4405F", role: "secondary" }, { hex: "#00AAFF", role: "accent" }])).toBe("#e4405f");
    expect(pickThemeColor([{ hex: "#00AAFF", role: "accent" }, { hex: "#22C55E", role: "primary" }])).toBe("#22c55e");
    expect(pickThemeColor([{ hex: "#fafafa", role: "background" }, { hex: "#ff0000", role: "background" }, { hex: "#222222", role: "primary" }])).toBeNull();
    expect(pickThemeColor(undefined)).toBeNull();
    expect(isThemeable("#e4405f")).toBe(true);
  });
});

function hsl(h: number, s: number, l: number): string {
  const S = s / 100;
  const L = l / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}
