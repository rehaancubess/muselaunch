import { copyRevisionRoute, factCheckRoute } from "@muselaunch/agents/testing";
import type { FixtureModule, J } from "./_types";

/**
 * FIXTURE MODE: the fact check and its one-tap fixes.
 *
 * - ClaimValidation behaves like the model on a small vocabulary (racing, bowling, mini golf): a word
 *   used in the copy is flagged unless the confirmed facts or listing evidence sent with the request
 *   contain it. The sample app's copy never uses these words, so its journey is unchanged.
 * - CopyRevision ("Remove it") deletes the flagged words and tidies the punctuation.
 * - "Pocket Play" (a fictional TV party-game app; create it with a description such as "Arcade games
 *   for your TV, played with your phone. Co-op fun for game night.") gets its own About-your-app and
 *   post copy that mentions racing and bowling, which its description doesn't back: the post is held
 *   back and the one-tap fixes can be tried. Import fixtures/agents/website-lineup.html instead and
 *   the line-up evidence backs them.
 */
const POCKET = /Pocket Play/;

/** Evidence ids in an App DNA request (`<id> | <kind> | <source> | <fact>`) whose fact matches. */
function evidenceIds(text: string, re: RegExp): string[] {
  return [...text.matchAll(/^(evd_\S+) \| [^|\n]+ \| [^|\n]+ \| ([^\n]*)$/gm)].filter((m) => re.test(m[2]!)).map((m) => m[1]!);
}

const mod: FixtureModule = (h) => ({
  meta: [
    factCheckRoute({ vocabulary: ["racing", "bowling", "mini golf"], statement: (t) => `Pocket Play has ${t.join(" and ")} games.` }),
    copyRevisionRoute(),
    (req: J) => {
      const name = h.schemaName(req);
      if (name !== "AppDna" && name !== "CopyPacks") return undefined;
      const text = h.requestText(req);
      if (!POCKET.test(text)) return undefined;
      if (name === "AppDna") {
        const tv = evidenceIds(text, /\bTV\b/i);
        const phone = evidenceIds(text, /phone/i);
        const coop = evidenceIds(text, /co-?op/i);
        const dna = {
          oneLiner: "Arcade party games for your TV, played with your phone.",
          description: "Fixture: Pocket Play turns a TV into a party arcade. Everyone joins by scanning one QR code and plays with their own phone as the controller.",
          category: "Games",
          platforms: ["tv"],
          screenshotObservations: [],
          features: [
            { name: "Arcade games on your TV", description: "Arcade games played on the TV.", evidenceIds: tv, assetIds: [] },
            { name: "Phones as controllers", description: "Everyone plays with their own phone.", evidenceIds: phone, assetIds: [] },
            { name: "Co-op game nights", description: "Co-op fun for game night.", evidenceIds: coop, assetIds: [] },
          ],
          audiences: [{ name: "Friends and families", description: "People who host game nights at home.", painPoints: ["Not enough controllers"], motivations: ["Everyone joins in"], evidenceIds: phone }],
          problems: [],
          differentiators: [{ text: "No controllers to buy: phones are the controllers.", evidenceIds: phone }],
          monetization: { model: "unknown", evidenceIds: [] },
          tone: { voice: ["playful", "warm"], vocabularyUse: ["game night"], vocabularyAvoid: [] },
          styleKeywords: ["bright", "arcade"],
          preferredCtas: ["Start a game night"],
          claims: [
            { text: "Arcade games for your TV", evidenceIds: tv, support: "direct", confidence: 0.95, contexts: ["all"] },
            { text: "Everyone plays with their own phone", evidenceIds: phone, support: "direct", confidence: 0.9, contexts: ["all"] },
            { text: "Co-op fun for game night", evidenceIds: coop, support: "direct", confidence: 0.9, contexts: ["all"] },
          ],
        };
        return h.responsesBody({ text: JSON.stringify(dna) });
      }
      const channels = [...text.matchAll(/^- ([a-z_]+): items /gm)].map((m) => m[1]!);
      const packs = channels.map((channel) => ({
        channel,
        items: [
          { kind: "caption", text: "Arcade, racing, bowling & co-op fun for game night. Grab your phones and play: [APP_LINK]" },
          { kind: "hashtags", text: "#gamenight #couchcoop #firetv" },
        ],
      }));
      return h.responsesBody({ text: JSON.stringify({ packs }) });
    },
  ],
});
export default mod;
