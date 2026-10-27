import type { EntityName } from "@muselaunch/contracts";
import { DbError, type ListQuery } from "./types";

/**
 * Declared Firestore composite indexes. This list is the single source of truth:
 * `pnpm --filter @muselaunch/db gen:indexes` writes `firestore.indexes.json`, and the
 * memory driver (tests) rejects any query Firestore would refuse without a composite index.
 * Add an entry here in the same change as any new filtered+ordered query.
 */
type Dir = "asc" | "desc";
export interface IndexDef {
  collection: EntityName;
  /** Equality / `in` fields, then optional array-contains field, then the ordered/range field last. */
  fields: { field: string; dir?: Dir; arrayContains?: boolean }[];
}

const byCreated = (collection: EntityName, ...eq: string[]): IndexDef => ({
  collection,
  fields: [...eq.map((field) => ({ field })), { field: "createdAt", dir: "desc" as const }],
});

const APP_SCOPED: EntityName[] = [
  "appImports",
  "appEvidence",
  "claims",
  "brandPreferences",
  "competitors",
  "trackedCreators",
  "researchRuns",
  "researchFindings",
  "audienceSegments",
  "opportunities",
  "agentRuns",
  "campaigns",
  "compositions",
  "copyPacks",
  "mediaAssets",
  "segmentations",
  "transcripts",
  "jobs",
  "approvals",
  "scheduledPosts",
  "publications",
  "outreachProspects",
  "outreachDrafts",
  "metricObservations",
  "attributionLinks",
  "importBatches",
  "experiments",
  "experimentResults",
  "recommendations",
  "modelUsage",
  "clipAnalyses",
  "brandReviews",
  "autopilots",
];

const CAMPAIGN_SCOPED: EntityName[] = ["campaignBriefs", "campaignVariants", "storyboards", "compositions", "copyPacks", "scheduledPosts", "mediaAssets", "publications", "metricObservations"];

export const INDEXES: IndexDef[] = [
  ...APP_SCOPED.map((c) => byCreated(c, "appId")),
  ...CAMPAIGN_SCOPED.map((c) => byCreated(c, "campaignId")),
  byCreated("jobs", "status"),
  byCreated("jobs", "appId", "status"),
  byCreated("opportunities", "appId", "status"),
  byCreated("claims", "appId", "state"),
  byCreated("brandPreferences", "appId", "active"),
  byCreated("brandPreferences", "active"),
  byCreated("mediaAssets", "appId", "role"),
  byCreated("mediaAssets", "appId", "kind"),
  byCreated("scheduledPosts", "appId", "status"),
  byCreated("outreachProspects", "appId", "status"),
  byCreated("researchFindings", "runId"),
  byCreated("compositionPatches", "compositionId"),
  byCreated("modelUsage", "agentRunId"),
  byCreated("modelUsage", "jobId"),
  byCreated("segmentations", "sourceAssetId"),
  byCreated("transcripts", "sourceAssetId"),
  byCreated("clipAnalyses", "sourceAssetId"),
  byCreated("brandReviews", "subject.id"),
  byCreated("autopilots", "appId", "status"),
  byCreated("approvals", "status"),
  byCreated("trackedCreators", "kind"),
  { collection: "compositionVersions", fields: [{ field: "compositionId" }, { field: "version", dir: "desc" }] },
  { collection: "agentSteps", fields: [{ field: "runId" }, { field: "index", dir: "asc" }] },
  { collection: "toolInvocations", fields: [{ field: "runId" }, { field: "createdAt", dir: "asc" }] },
  { collection: "jobEvents", fields: [{ field: "jobId" }, { field: "seq", dir: "asc" }] },
  { collection: "scheduledPosts", fields: [{ field: "status" }, { field: "scheduledAt", dir: "asc" }] },
  { collection: "metricObservations", fields: [{ field: "appId" }, { field: "windowStart", dir: "desc" }] },
  { collection: "metricObservations", fields: [{ field: "appId" }, { field: "metric" }, { field: "windowStart", dir: "desc" }] },
  { collection: "metricObservations", fields: [{ field: "campaignId" }, { field: "windowStart", dir: "desc" }] },
];

const RANGE_OPS = new Set(["<", "<=", ">", ">=", "!=", "not-in"]);
const ARRAY_OPS = new Set(["array-contains", "array-contains-any"]);

/** Throws MISSING_INDEX when Firestore would need a composite index not declared above. */
export function assertIndexed(collection: EntityName, q: ListQuery, indexes: IndexDef[] = INDEXES): void {
  const where = q.where ?? [];
  const eq = new Set<string>();
  let arrayField: string | undefined;
  const range = new Set<string>();
  for (const [field, op] of where) {
    if (ARRAY_OPS.has(op)) arrayField = field;
    else if (RANGE_OPS.has(op)) range.add(field);
    else eq.add(field);
  }
  const order = q.orderBy;
  const involved = new Set<string>([...eq, ...range, ...(arrayField ? [arrayField] : []), ...(order ? [order.field] : [])]);
  // Single-field queries, and pure-equality queries (index merging), need no composite index.
  if (involved.size <= 1) return;
  if (!order && range.size === 0 && !arrayField) return;
  if (range.size > 1) {
    throw new DbError("MISSING_INDEX", `Query on ${collection} uses range filters on multiple fields (${[...range].join(", ")})`);
  }
  const last = order?.field ?? [...range][0];
  const ok = indexes.some((idx) => {
    if (idx.collection !== collection) return false;
    const fields = idx.fields.map((f) => f.field);
    if (fields.length !== involved.size || !fields.every((f) => involved.has(f))) return false;
    const tail = idx.fields[idx.fields.length - 1]!;
    if (last && tail.field !== last) return false;
    if (order && (tail.dir ?? "asc") !== (order.dir ?? "asc")) return false;
    if (arrayField && !idx.fields.some((f) => f.field === arrayField && f.arrayContains)) return false;
    return true;
  });
  if (!ok) {
    const shape = `${collection}: where[${[...eq].join(",")}${arrayField ? ` contains:${arrayField}` : ""}${range.size ? ` range:${[...range].join(",")}` : ""}] orderBy ${order ? `${order.field} ${order.dir ?? "asc"}` : "-"}`;
    throw new DbError("MISSING_INDEX", `No composite index declared for query ${shape}. Add it to packages/db/src/indexes.ts.`);
  }
}

export function toFirestoreIndexesJson(indexes: IndexDef[] = INDEXES) {
  const seen = new Set<string>();
  const out = [] as { collectionGroup: string; queryScope: "COLLECTION"; fields: ({ fieldPath: string; arrayConfig: string } | { fieldPath: string; order: string })[] }[];
  for (const idx of indexes) {
    const key = JSON.stringify(idx);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      collectionGroup: idx.collection,
      queryScope: "COLLECTION",
      fields: idx.fields.map((f) =>
        f.arrayContains ? { fieldPath: f.field, arrayConfig: "CONTAINS" } : { fieldPath: f.field, order: (f.dir ?? "asc") === "asc" ? "ASCENDING" : "DESCENDING" },
      ),
    });
  }
  return { indexes: out, fieldOverrides: [] };
}
