import { autopilotDecisionRoute } from "@muselaunch/autopilot/testing";
import type { FixtureModule } from "./_types";

/**
 * FIXTURE MODE: Muse Wonder's Growth Autopilot decisions (choose_audience, set_hypothesis,
 * pick_variants, plan_next_iteration), built from ids present in the request so they validate.
 * Rationale prose is prefixed "Fixture:"; nothing here claims measured results.
 */
const mod: FixtureModule = (h) => {
  const d = h.fixtureJson<Record<string, Record<string, unknown>>>("wonder-autopilot-decisions.json");
  const fx = (o: Record<string, unknown>) => ({ ...o, rationale: `Fixture: ${String(o.rationale)}` });
  return { meta: [autopilotDecisionRoute({ choose_audience: fx(d.choose_audience!), plan_next_iteration: fx(d.plan_next_iteration!) })] };
};
export default mod;
