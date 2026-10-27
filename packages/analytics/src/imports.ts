import type { CreateImportRequest, ImportBatch, ImportOptions, ManualObservationRequest, MetricObservation } from "@muselaunch/contracts";
import { nowIso } from "@muselaunch/db";
import { AppError, assertKeyInWorkspace, type JobHandler, type Platform } from "@muselaunch/platform";
import { parseImport, type ObservationDraft, type ParseOutcome } from "./csv";
import { METRIC_INFO } from "./metrics";
import { upsertObservation } from "./observations";

const MAX_IMPORT_BYTES = 20 * 1024 * 1024;
const CSV_MIME = /^(text\/csv|text\/plain|text\/tab-separated-values|application\/vnd\.ms-excel)$/;

async function loadImportFile(p: Platform, workspaceId: string, assetId: string, appId: string): Promise<{ bytes: Buffer; filename?: string }> {
  const asset = await p.db.ws(workspaceId).collection("mediaAssets").getOrThrow(assetId);
  if (asset.appId && asset.appId !== appId) throw new AppError("BAD_REQUEST", "That file belongs to a different app");
  if (asset.kind !== "document" || !CSV_MIME.test(asset.mimeType)) throw new AppError("BAD_REQUEST", `Expected a CSV/TSV document, got ${asset.mimeType}`, { userMessage: "Upload a .csv or .tsv file." });
  if (asset.status === "pending_upload" || asset.status === "deleted") throw new AppError("CONFLICT", "The file upload hasn't completed", { userMessage: "Finish uploading the file first." });
  if (asset.bytes > MAX_IMPORT_BYTES) throw new AppError("BAD_REQUEST", "File too large for import", { userMessage: "Imports can be up to 20 MB." });
  assertKeyInWorkspace(workspaceId, asset.storagePath);
  const bytes = await p.storage.get(asset.storagePath);
  return { bytes, filename: asset.originalFilename };
}

function previewOf(out: ParseOutcome): ImportBatch["preview"] {
  return out.drafts.slice(0, 20).map((d) => ({ row: d.rows[0]!, date: d.windowStart.slice(0, 10), metric: d.metric, value: d.value, currency: d.currency, channel: d.channel }));
}

/** Parse an uploaded CSV into a preview batch (status `parsed`). Nothing is written to metrics yet. */
export async function createImportPreview(p: Platform, workspaceId: string, appId: string, input: CreateImportRequest, actor: string): Promise<{ batch: ImportBatch; warnings: string[]; observationsPreviewCount: number }> {
  await p.db.ws(workspaceId).collection("apps").getOrThrow(appId);
  if (input.options?.campaignId) await p.db.ws(workspaceId).collection("campaigns").getOrThrow(input.options.campaignId);
  const file = await loadImportFile(p, workspaceId, input.assetId, appId);
  const out = parseImport({ bytes: file.bytes, filename: file.filename, format: input.format, mapping: input.mapping, options: input.options });
  const batch = await p.db.ws(workspaceId).collection("importBatches").create(
    {
      appId,
      kind: "csv",
      filename: file.filename,
      assetId: input.assetId,
      rowCount: out.rowCount,
      acceptedCount: out.acceptedRows,
      rejected: out.rejected,
      mapping: out.mapping,
      status: "parsed",
      detectedFormat: out.format,
      columns: out.columns.slice(0, 200).map((c) => c.slice(0, 200)),
      options: { ...(input.options ?? {}), source: out.source, timezone: out.timezone },
      preview: previewOf(out),
    },
    { actor },
  );
  const warnings = [...out.warnings];
  if (out.rejectedTotal > out.rejected.length) warnings.push(`${out.rejectedTotal - out.rejected.length} more rejected rows are not listed.`);
  return { batch, warnings, observationsPreviewCount: out.drafts.length };
}

/** Update mapping/options on a parsed batch and re-run the preview. */
export async function remapImport(p: Platform, workspaceId: string, batchId: string, input: { mapping?: Record<string, string>; options?: ImportOptions }, actor: string): Promise<ImportBatch> {
  const repo = p.db.ws(workspaceId).collection("importBatches");
  const batch = await repo.getOrThrow(batchId);
  if (batch.kind !== "csv" || !batch.assetId) throw new AppError("BAD_REQUEST", "Only CSV imports can be remapped");
  if (batch.status === "committed") throw new AppError("CONFLICT", "This import was already committed");
  if (!input.mapping && !input.options) return batch;
  const options = { ...batch.options, ...(input.options ?? {}) };
  if (options.campaignId) await p.db.ws(workspaceId).collection("campaigns").getOrThrow(options.campaignId);
  const file = await loadImportFile(p, workspaceId, batch.assetId, batch.appId);
  const out = parseImport({ bytes: file.bytes, filename: file.filename, format: batch.detectedFormat === "manual" ? undefined : batch.detectedFormat, mapping: { ...batch.mapping, ...(input.mapping ?? {}) }, options });
  return repo.update(batchId, { mapping: out.mapping, options: { ...options, source: out.source, timezone: out.timezone }, rejected: out.rejected, acceptedCount: out.acceptedRows, rowCount: out.rowCount, preview: previewOf(out), status: "parsed", error: undefined }, { actor });
}

function draftToObservation(d: ObservationDraft, batch: ImportBatch): Parameters<typeof upsertObservation>[1] {
  const campaignId = batch.options.campaignId;
  const attribution = batch.options.attribution ?? (campaignId ? "none" : "aggregate");
  return {
    appId: batch.appId,
    campaignId,
    source: d.source,
    metric: d.metric,
    metricDefinition: d.definition.slice(0, 500),
    value: d.value,
    unit: METRIC_INFO[d.metric].unit,
    currency: d.currency,
    windowStart: d.windowStart,
    windowEnd: d.windowEnd,
    timezone: d.timezone,
    channel: d.channel,
    attribution,
    provenance: { imported: true, importId: batch.id, fetchedAt: nowIso(), rawRowRef: `${batch.filename ?? "import"} rows ${compactRows(d.rows)}`.slice(0, 300) },
    // Same scope across imports: re-importing an overlapping file replaces values instead of double counting.
    scope: `import:${d.source}:${batch.appId}:${d.metric}:${d.channel ?? "*"}:${campaignId ?? "*"}:${d.currency ?? "*"}`,
  };
}

function compactRows(rows: number[]): string {
  const sorted = [...new Set(rows)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    parts.push(i === j ? `${sorted[i]}` : `${sorted[i]}-${sorted[j]}`);
    i = j;
  }
  return parts.join(",");
}

/** Job `analytics.import_csv`: write observations for a parsed batch (idempotent: upserts by dedup key). */
export const importCsvHandler: JobHandler<"analytics.import_csv"> = async (ctx) => {
  const { appId, importBatchId } = ctx.payload;
  const repo = ctx.ws.collection("importBatches");
  const batch = await repo.getOrThrow(importBatchId);
  if (batch.appId !== appId) throw new AppError("BAD_REQUEST", "Import batch does not belong to this app", { retryable: false });
  if (batch.status === "committed") return { refs: [{ entity: "importBatches", id: batch.id }], data: { alreadyCommitted: true, observationCount: batch.observationCount ?? 0 } };
  if (batch.kind !== "csv" || !batch.assetId) throw new AppError("BAD_REQUEST", "Only CSV batches are committed by this job", { retryable: false });
  await ctx.progress(5, "reading file");
  const file = await loadImportFile(ctx.platform, ctx.workspaceId, batch.assetId, appId);
  const out = parseImport({ bytes: file.bytes, filename: file.filename, format: batch.detectedFormat === "manual" ? undefined : batch.detectedFormat, mapping: batch.mapping, options: batch.options });
  if (!out.drafts.length) {
    await repo.update(batch.id, { status: "failed", error: "No valid rows to import", rejected: out.rejected, acceptedCount: 0 }, { actor: ctx.actor });
    throw new AppError("VALIDATION_FAILED", "No valid rows to import", { retryable: false, userMessage: "None of the rows could be imported. Check the column mapping and rejected rows." });
  }
  let written = 0;
  for (const [i, d] of out.drafts.entries()) {
    ctx.throwIfCancelled();
    await upsertObservation(ctx.ws, draftToObservation(d, batch), ctx.actor);
    written++;
    if (i % 50 === 0) await ctx.progress(10 + Math.round((i / out.drafts.length) * 85), "writing observations", `${i}/${out.drafts.length}`);
  }
  await repo.update(batch.id, { status: "committed", committedAt: nowIso(), observationCount: written, acceptedCount: out.acceptedRows, rejected: out.rejected, rowCount: out.rowCount, error: undefined }, { actor: ctx.actor });
  await ctx.log_event(`Imported ${written} observations from ${batch.filename ?? "CSV"} (labelled Imported)`, { entity: "importBatches", id: batch.id });
  return { refs: [{ entity: "importBatches", id: batch.id }], data: { observationCount: written, rejected: out.rejectedTotal }, creditsUsed: 0 };
};

/** Remove the observations an import still owns (later imports of the same rows keep theirs). */
export async function rollbackImport(p: Platform, workspaceId: string, batchId: string, actor: string): Promise<{ deleted: number }> {
  const ws = p.db.ws(workspaceId);
  const batch = await ws.collection("importBatches").getOrThrow(batchId);
  let deleted = 0;
  for (;;) {
    const page = await ws.collection("metricObservations").list({ where: [["provenance.importId", "==", batch.id]], limit: 200 });
    if (!page.items.length) break;
    for (const o of page.items) {
      await ws.collection("metricObservations").delete(o.id);
      deleted++;
    }
  }
  await ws.collection("importBatches").update(batch.id, { status: "failed", error: `Rolled back by ${actor}: ${deleted} observations removed` }, { actor });
  return { deleted };
}

/** Manual entry: one labelled observation (source `manual`, provenance.imported = true). */
export async function recordManualObservation(p: Platform, workspaceId: string, appId: string, input: ManualObservationRequest, actor: string): Promise<{ observation: MetricObservation; batch: ImportBatch }> {
  const ws = p.db.ws(workspaceId);
  await ws.collection("apps").getOrThrow(appId);
  const start = Date.parse(input.windowStart);
  const end = Date.parse(input.windowEnd);
  if (!(end > start)) throw new AppError("BAD_REQUEST", "windowEnd must be after windowStart");
  if (end > Date.now() + 86_400_000) throw new AppError("BAD_REQUEST", "Window ends in the future", { userMessage: "You can only enter numbers for periods that have happened." });
  const info = METRIC_INFO[input.metric];
  const unit = input.unit ?? info.unit;
  if (unit !== info.unit) throw new AppError("BAD_REQUEST", `${input.metric} is measured in ${info.unit}`);
  if (unit === "currency" && !input.currency) throw new AppError("BAD_REQUEST", "currency is required for money metrics");
  if (unit === "count" && (input.value < 0 || !Number.isInteger(input.value))) throw new AppError("BAD_REQUEST", "Counts must be whole, non-negative numbers");
  if (input.campaignId) await ws.collection("campaigns").getOrThrow(input.campaignId);
  if (input.experimentId) await ws.collection("experiments").getOrThrow(input.experimentId);
  if (input.publicationId) await ws.collection("publications").getOrThrow(input.publicationId);
  const batch = await ws.collection("importBatches").create(
    {
      appId,
      kind: "manual",
      rowCount: 1,
      acceptedCount: 1,
      rejected: [],
      mapping: {},
      status: "committed",
      detectedFormat: "manual",
      options: { source: "manual", timezone: input.timezone, channel: input.channel, campaignId: input.campaignId, attribution: input.attribution, definitionNote: input.definition },
      committedAt: nowIso(),
      observationCount: 1,
    },
    { actor },
  );
  const scope = `manual:${appId}:${input.metric}:${input.channel ?? "*"}:${input.campaignId ?? "*"}:${input.publicationId ?? "*"}:${input.experimentId ?? "*"}:${input.variantKey ?? "*"}:${input.currency ?? "*"}`;
  const { observation } = await upsertObservation(
    ws,
    {
      appId,
      campaignId: input.campaignId,
      publicationId: input.publicationId,
      experimentId: input.experimentId,
      variantKey: input.variantKey,
      source: "manual",
      metric: input.metric,
      metricDefinition: `Manual entry: ${input.definition}`.slice(0, 500),
      value: input.value,
      unit,
      currency: input.currency,
      windowStart: new Date(start).toISOString(),
      windowEnd: new Date(end).toISOString(),
      timezone: input.timezone,
      channel: input.channel,
      attribution: input.attribution,
      provenance: { imported: true, importId: batch.id, fetchedAt: nowIso(), rawRowRef: `manual entry by ${actor}`.slice(0, 300) },
      scope,
    },
    actor,
  );
  return { observation, batch };
}
