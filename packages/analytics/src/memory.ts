import type { BrandPreference, PreferenceKind } from "@muselaunch/contracts";
import type { Platform } from "@muselaunch/platform";
import type { z } from "zod";

type Kind = z.infer<typeof PreferenceKind>;

/**
 * Brand memory port (module B owns the implementation: `retrieveMemory` / `rememberPreference` in
 * @muselaunch/agents, Glimmer-backed). Until B's branch lands, a direct Firestore fallback is used:
 * it reads/writes the same `brandPreferences` collection with deterministic ranking and reports
 * `usedGlimmer: false`, so nothing pretends Glimmer ran.
 */

export interface MemoryApi {
  retrieveMemory(p: Platform, input: { workspaceId: string; appId?: string; task: string; query: string; limit?: number; jobId?: string }): Promise<{ items: BrandPreference[]; summary: string; usedGlimmer: boolean }>;
  rememberPreference(p: Platform, input: { workspaceId: string; appId?: string; kind: Kind; text: string; source: BrandPreference["source"]; actor: string }): Promise<BrandPreference>;
}

let override: MemoryApi | undefined;
/** Tests can install a fake; production resolves module B's implementation. */
export function installMemoryApi(api: MemoryApi | undefined): void {
  override = api;
}

async function agentsApi(): Promise<Partial<MemoryApi>> {
  try {
    const mod = (await import("@muselaunch/agents")) as Record<string, unknown>;
    return {
      retrieveMemory: typeof mod.retrieveMemory === "function" ? (mod.retrieveMemory as MemoryApi["retrieveMemory"]) : undefined,
      rememberPreference: typeof mod.rememberPreference === "function" ? (mod.rememberPreference as MemoryApi["rememberPreference"]) : undefined,
    };
  } catch {
    return {};
  }
}

const fallback: MemoryApi = {
  async retrieveMemory(p, input) {
    const ws = p.db.ws(input.workspaceId);
    const limit = input.limit ?? 8;
    const [app, global] = await Promise.all([
      input.appId ? ws.collection("brandPreferences").list({ where: [["appId", "==", input.appId], ["active", "==", true]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 }) : Promise.resolve({ items: [] as BrandPreference[] }),
      ws.collection("brandPreferences").list({ where: [["active", "==", true]], orderBy: { field: "createdAt", dir: "desc" }, limit: 50 }),
    ]);
    const pool = [...app.items, ...global.items.filter((x) => !x.appId)];
    const words = new Set(input.query.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
    const scored = pool
      .map((x) => {
        const overlap = x.text.toLowerCase().split(/\W+/).filter((w) => words.has(w)).length;
        const kindBoost = x.kind === "lesson" || x.kind === "decision" ? 1 : 0;
        return { x, score: overlap + kindBoost + x.weight };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.x);
    return { items: scored, summary: scored.map((x) => `- (${x.kind}) ${x.text}`).join("\n"), usedGlimmer: false };
  },
  async rememberPreference(p, input) {
    return p.db
      .ws(input.workspaceId)
      .collection("brandPreferences")
      .create({ appId: input.appId, kind: input.kind, text: input.text.slice(0, 1000), source: input.source, weight: 0.6, tags: ["analytics"], active: true }, { actor: input.actor });
  },
};

export async function memoryApi(): Promise<MemoryApi & { implementation: "agents" | "fallback" | "override" }> {
  if (override) return { ...override, implementation: "override" };
  const a = await agentsApi();
  if (a.retrieveMemory && a.rememberPreference) return { retrieveMemory: a.retrieveMemory, rememberPreference: a.rememberPreference, implementation: "agents" };
  return { ...fallback, implementation: "fallback" };
}
