import { createHash } from "node:crypto";
import type { CreateInput, MetricObservation } from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";

export const hashId = (prefix: string, key: string, len = 26) => `${prefix}_${createHash("sha256").update(key).digest("hex").slice(0, len)}`;

/**
 * Dedup keys are `<scope>|<windowStart>|<windowEnd>`. The scope identifies one series
 * (source + account + metric + campaign/publication/link + currency). Observations in the same
 * scope with overlapping windows describe the same thing and must never be added together.
 */
export function makeDedupKey(scope: string, windowStart: string, windowEnd: string): string {
  const s = scope.length > 180 ? `h:${createHash("sha256").update(scope).digest("hex").slice(0, 40)}` : scope;
  return `${s}|${windowStart}|${windowEnd}`;
}

export function scopeOf(o: Pick<MetricObservation, "dedupKey">): string {
  const i = o.dedupKey.indexOf("|");
  return i >= 0 ? o.dedupKey.slice(0, i) : o.dedupKey;
}

export const observationIdFor = (dedupKey: string) => hashId("obs", dedupKey);

export type ObservationInput = Omit<CreateInput<"metricObservations">, "id" | "dedupKey"> & {
  scope: string;
  /** Override the window part of the dedup key (e.g. one snapshot per UTC day). */
  dedupWindow?: string;
};

/**
 * Upsert by dedup key (deterministic id), so re-syncs and re-imports replace values instead of
 * double counting. Returns whether the doc was created or updated.
 */
export async function upsertObservation(ws: WorkspaceDb, input: ObservationInput, actor: string): Promise<{ observation: MetricObservation; created: boolean }> {
  const { scope, dedupWindow, ...rest } = input;
  const dedupKey = dedupWindow ? `${makeDedupKey(scope, "", "").split("|")[0]}|${dedupWindow}` : makeDedupKey(scope, rest.windowStart, rest.windowEnd);
  const id = observationIdFor(dedupKey);
  const repo = ws.collection("metricObservations");
  const { entity, created } = await repo.createIfAbsent({ ...rest, id, dedupKey }, { actor });
  if (created) return { observation: entity, created };
  const changed =
    entity.value !== rest.value ||
    entity.windowStart !== rest.windowStart ||
    entity.windowEnd !== rest.windowEnd ||
    entity.metricDefinition !== rest.metricDefinition ||
    entity.provenance.importId !== rest.provenance.importId ||
    entity.attribution !== rest.attribution ||
    entity.campaignId !== rest.campaignId;
  if (!changed) return { observation: entity, created: false };
  const updated = await repo.update(id, { ...rest, dedupKey, provenance: { ...rest.provenance, fetchedAt: rest.provenance.fetchedAt ?? nowIso() } } as Partial<MetricObservation>, { actor });
  return { observation: updated, created: false };
}

export const DAY_MS = 86_400_000;

export function utcDayStart(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
