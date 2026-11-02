import { copyRewriteRoute } from "@muselaunch/agents/testing";
import type { FixtureModule, J } from "./_types";

/**
 * FIXTURE MODE: "Tell Muse what to change" (Creator → Today, the post sheet, the simple Studio).
 *
 * - CopyRewrite (caption changes) edits the post's own words deterministically (agents/testing.ts).
 * - CompositionEdit for Today's quick chips ("Shorter", "Different start", "More energetic") changes
 *   the opening scene's headline in a way that matches the ask; every other instruction falls
 *   through to the built-in CompositionEdit fixture. Summaries say "Fixture:".
 */
const mod: FixtureModule = (h) => ({
  meta: [
    copyRewriteRoute(),
    (req: J) => {
      if (h.schemaName(req) !== "CompositionEdit") return undefined;
      const text = h.requestText(req);
      const ask = (text.match(/Instruction from the founder: (.+)/)?.[1] ?? "").toLowerCase();
      const kind = /shorter|tighten|trim/.test(ask) ? "shorter" : /different start|new start|opening|hook/.test(ask) && !/hook brief/i.test(text) ? "start" : /energetic|energy|punchier|exciting/.test(ask) ? "energy" : null;
      if (!kind || /Hook brief: /.test(text)) return undefined;
      const sceneId = text.match(/Edit ONLY these scenes: (\S+?)(?:,|\s|$)/)?.[1] ?? text.match(/scene id=(\S+)/)?.[1];
      if (!sceneId) return undefined;
      const block = (text.split(`scene id=${sceneId} `)[1] ?? "").split(/\n\s+\d+\. scene id=/)[0]!;
      const m = block.match(/layer id=(\S+) text(?: "[^"]*")? role=headline text=("(?:[^"\\]|\\.)*")/) ?? block.match(/layer id=(\S+) text(?: "[^"]*")? role=\w+ text=("(?:[^"\\]|\\.)*")/);
      if (!m) return undefined;
      const now = (JSON.parse(m[2]!) as string).replace(/…$/, "");
      const words = now.split(/\s+/).filter(Boolean);
      const next =
        kind === "shorter"
          ? words.length > 3
            ? `${words.slice(0, 3).join(" ").replace(/[,.;:!?]+$/, "")}.`
            : now
          : kind === "energy"
            ? `${now.replace(/[.!?]+$/, "")}!`
            : "Where did your focus go today?";
      if (next === now) return undefined;
      const summary = kind === "shorter" ? "Fixture: made the opening line shorter" : kind === "energy" ? "Fixture: gave the opening line more energy" : "Fixture: started with a question instead";
      return h.responsesBody({ text: JSON.stringify({ summary, targetSceneIds: [sceneId], ops: [{ op: "update_layer", sceneId, layerId: m[1], set: { text: next } }] }) });
    },
  ],
});
export default mod;
