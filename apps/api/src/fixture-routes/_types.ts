/**
 * Extension contract for FIXTURE MODE (apps/api/src/dev-fixture.ts).
 *
 * Add one file per feature in this folder (e.g. `autopilot.ts`, `guardian.ts`) with a default export:
 *
 *   import type { FixtureModule } from "./_types";
 *   const mod: FixtureModule = (h) => ({
 *     meta: [
 *       // Structured-output call: generateJson({ schemaName: "AutopilotDecision", ... })
 *       h.jsonRoute("AutopilotDecision", (req) => ({ choice: h.idsIn(h.requestText(req), "fnd")[0] ?? null, rationale: "Fixture: …" })),
 *       // Wonder tool loop: turns restart for every new loop (request without previous_response_id)
 *       h.loopRoute([[{ name: "my_tool", args: { id: "$ID:cpg:0" } }], [{ name: "finish", args: { summary: "Fixture: done" } }]], (req) => h.toolNames(req).includes("my_tool")),
 *     ],
 *     // Optional: answer Glimmer chat calls you recognise; return undefined to fall through.
 *     glimmer: (messages) => (messages[0]?.content.includes("Brand Guardian") ? JSON.stringify({ findings: [] }) : undefined),
 *   });
 *   export default mod;
 *
 * Rules: build outputs only from ids/text present in the request (so they validate), keep any prose
 * prefixed "Fixture:" where a user could see it, and never fabricate metrics. Files starting with "_"
 * are ignored. Unmatched requests fail visibly with "fixture mode: no fixture for <schema>".
 */
export type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type MetaRoute = (req: J, index: number) => unknown;
export type GlimmerReply = (messages: { role: string; content: string }[]) => string | undefined;

export interface FixtureHelpers {
  jsonRoute: (schemaName: string, build: (req: J) => unknown) => MetaRoute;
  loopRoute: (turns: { name: string; args: unknown }[][], match: (req: J) => boolean) => MetaRoute;
  responsesBody: (opts: { text?: string; functionCalls?: { name: string; args: unknown }[]; citations?: { url: string; title?: string }[] }) => Record<string, unknown>;
  requestText: (req: J) => string;
  schemaName: (req: J) => string | undefined;
  toolNames: (req: J) => string[];
  idsIn: (text: string, prefix: string) => string[];
  fixtureJson: <T = Record<string, unknown>>(name: string) => T;
  resolvePlaceholders: <T>(template: T, req: J) => T;
}

export type FixtureModule = (h: FixtureHelpers) => { meta?: MetaRoute[]; glimmer?: GlimmerReply };
