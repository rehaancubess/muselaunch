import type { FixtureModule } from "./_types";

/**
 * Brand Guardian (module G) in fixture mode: answers the Glimmer review call with an honest,
 * labelled "no issues" result. Deterministic rule findings still come from the real rules, so a
 * blocked claim or banned phrase is still caught. Replace with richer fixtures as needed.
 */
const guardian: FixtureModule = () => ({
  glimmer: (messages) =>
    messages.some((m) => m.role === "system" && m.content.includes("acting as MuseLaunch's Brand Guardian"))
      ? JSON.stringify({ summary: "Fixture: Muse Glimmer review from a test fixture. No additional issues beyond the deterministic rules.", findings: [] })
      : undefined,
});

export default guardian;
