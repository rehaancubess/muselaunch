import type { FixtureModule, J } from "./_types";

/**
 * FIXTURE MODE: test analysis (ExperimentAnalysis) when every version of a test has its main number
 * measured. The measured sentence is built only from MuseLaunch's own per-version totals and cites
 * the observation ids in the request, so the server-side validation (ids, figures, causal wording)
 * checks it like a model answer. Confidence stays "low" (fixture samples are small). Any other
 * request (no data, a version without its number) falls through to the built-in "insufficient
 * data" fixture. Prose is labelled "Fixture:"; nothing here explains why a version did better.
 */
const WORDS: Record<string, string> = { clicks: "link clicks", views: "views", installs: "installs", likes: "likes" };

const mod: FixtureModule = (h) => ({
  meta: [
    (req: J) => {
      if (h.schemaName(req) !== "ExperimentAnalysis") return undefined;
      const text = h.requestText(req);
      const primary = text.match(/Primary metric: (\w+)/)?.[1];
      const variantsLine = text.match(/^Variants: (.+)$/m)?.[1];
      const totals = text.match(/Per-variant totals computed by MuseLaunch[^\n]*:\n(.+)/)?.[1];
      if (!primary || !variantsLine || !totals) return undefined;
      const labels = new Map(
        variantsLine.split("; ").map((v) => {
          const m = v.match(/^([^:\s]+)(?: \(control\))?: (.+)$/);
          return [m?.[1] ?? v, m?.[2] ?? v] as const;
        }),
      );
      let perVariant: { key: string; metrics: { metric: string; value: number | null }[] }[];
      try {
        perVariant = JSON.parse(totals);
      } catch {
        return undefined;
      }
      const rows = perVariant.filter((v) => v.key !== "baseline").map((v) => ({ key: v.key, label: labels.get(v.key) ?? v.key, value: v.metrics.find((m) => m.metric === primary)?.value ?? null }));
      if (rows.length < 2 || rows.some((r) => r.value === null)) return undefined;
      const ids = [...text.matchAll(/^(obs_\S+) \| variant=(\S+) \| (\w+) = /gm)].filter((m) => m[2] !== "baseline" && m[3] === primary).map((m) => m[1]!);
      if (!ids.length) return undefined;
      const words = WORDS[primary] ?? primary.replace(/_/g, " ");
      const sorted = [...rows].sort((a, b) => b.value! - a.value!);
      const sentence = sorted.map((r, i) => (i === 0 ? `${r.label} got ${r.value} ${words}` : `${r.label} got ${r.value}`)).join("; ");
      return h.responsesBody({
        text: JSON.stringify({
          summary: `Fixture: compares the ${words} measured for each version.`,
          measured: [{ text: `Fixture: ${sentence}.`, observationIds: ids }],
          hypotheses: ["Fixture: a test fixture wrote this, so it doesn't say why one version got more."],
          limitations: ["Fixture: small sample.", "Only the posts linked to each version are counted."],
          confidence: "low",
        }),
      });
    },
  ],
});

export default mod;
