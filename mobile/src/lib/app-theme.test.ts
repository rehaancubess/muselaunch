import { MONOCHROME, themeFor } from "./app-theme";

describe("the interface colour follows the app", () => {
  it("is monochrome (graphite) by default and for an app without a colour", () => {
    expect(MONOCHROME).toEqual({ accent: "#1d1d1f", accentHover: "#000000", accentSoft: "#f0f0f2", accentInk: "#1d1d1f", gradient: ["#5a5a60", "#1d1d1f", "#000000"] });
    expect(themeFor(null)).toBe(MONOCHROME);
    expect(themeFor({})).toBe(MONOCHROME);
    expect(themeFor({ theme: { color: null, source: "icon" } })).toBe(MONOCHROME);
  });
});
