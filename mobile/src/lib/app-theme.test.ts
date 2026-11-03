import { contrastRatio, MONOCHROME, themeFor, themeTokens } from "./app-theme";

describe("the interface colour follows the app", () => {
  it("is monochrome (graphite) by default, for an app without a colour and for a grey one", () => {
    expect(MONOCHROME).toMatchObject({ accent: "#1d1d1f", accentHover: "#000000", accentSoft: "#f0f0f2", accentInk: "#1d1d1f", gradient: ["#5a5a60", "#1d1d1f", "#000000"] });
    expect(themeFor(null)).toBe(MONOCHROME);
    expect(themeFor({})).toBe(MONOCHROME);
    expect(themeFor({ theme: { color: null, source: "icon" } })).toBe(MONOCHROME);
    expect(themeFor({ theme: { color: "#808080", source: "custom" } })).toBe(MONOCHROME);
    expect(themeFor({ theme: { color: "not a colour", source: "custom" } })).toBe(MONOCHROME);
  });

  it("uses the app's colour, darkened only as far as WCAG AA needs, keeping its hue", () => {
    for (const c of ["#ff9500", "#ffcc00", "#34c759", "#00c7be", "#007aff", "#5856d6", "#af52de", "#ff2d55", "#7c3aed", "#a2845e"]) {
      const t = themeFor({ theme: { color: c, source: "icon" } });
      expect(t.color).toBe(c);
      expect(contrastRatio(t.accent, "#ffffff")).toBeGreaterThanOrEqual(4.8);
      expect(contrastRatio(t.accent, t.accentSoft)).toBeGreaterThanOrEqual(4.5);
      expect(t.gradient[1]).toBe(t.accent);
    }
    // A dark enough colour is used as it is.
    expect(themeTokens("#1e3a8a").accent).toBe("#1e3a8a");
    // The same colour gives the same object (no re-render churn).
    expect(themeFor({ theme: { color: "#007aff", source: "icon" } })).toBe(themeFor({ theme: { color: "#007aff", source: "custom" } }));
  });
});
