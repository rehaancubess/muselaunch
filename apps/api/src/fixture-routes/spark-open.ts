import type { FixtureModule } from "./_types";

/**
 * FIXTURE MODE: demo the visible Muse Spark → Muse Spark Open fallback.
 *
 * FIXTURE_META_RATE_LIMIT=CompositionEdit (comma-separated schema names, or "all") makes the fake Meta
 * answer those Muse Spark calls with its documented 429 envelope. The router then runs the same request
 * on (fake) Muse Spark Open and the agent run shows "Muse Spark was rate-limited; used Muse Spark Open
 * (open weights) instead". Off unless the variable is set. Only Muse Spark (Meta) requests match: Spark
 * Open requests carry the "meta-models/…" slug and Wonder requests "muse-wonder…".
 */
const mod: FixtureModule = (h) => {
  const names = (process.env.FIXTURE_META_RATE_LIMIT ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!names.length) return {};
  return {
    meta: [
      (req) => {
        if (!String(req.model ?? "").startsWith("muse-spark")) return undefined;
        const name = h.schemaName(req);
        if (!name || !(names.includes("all") || names.includes(name))) return undefined;
        return new Response(JSON.stringify({ error: { message: "Fixture: simulated Meta rate limit (FIXTURE_META_RATE_LIMIT), not a real limit", type: "rate_limit_error", code: "rate_limit_exceeded" } }), {
          status: 429,
          headers: { "content-type": "application/json", "retry-after-ms": "200" },
        });
      },
    ],
  };
};
export default mod;
