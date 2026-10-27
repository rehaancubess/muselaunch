"use client";
import type { AttributionLink, Campaign, Channel, ConnectedAccount, ImportBatch, ImportOptions, Job, MetricObservation } from "@muselaunch/contracts";
import { MetricName } from "@muselaunch/contracts";
import { Badge, Button, Card, Checkbox, Field, Input, JobProgress, Notice, Section, Select, StatusPill, statusKindOf, useToast } from "@muselaunch/ui";
import { Copy, FileUp, KeyRound, Link2, PenLine, RefreshCw, Undo2 } from "lucide-react";
import { useRef, useState } from "react";
import { api, errorMessage, newIdempotencyKey, uploadToSignedUrl, wsPath } from "@/lib/api";
import type { CompleteUploadResponse, Page, UploadResponse } from "@/lib/api-types";
import { useJob } from "@/lib/jobs";
import { CHANNEL_LABEL } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import type { SourcesFocus } from "./overview";
import { fmtDate, type ImportCommitResponse, type ImportPreviewResponse } from "./shared";

const METRIC_OPTIONS = MetricName.options.map((m) => ({ value: m, label: m.replace(/_/g, " ") }));
const CHANNEL_OPTIONS = Object.entries(CHANNEL_LABEL).map(([value, label]) => ({ value, label }));
const CURRENCIES = ["USD", "EUR", "GBP", "INR", "JPY", "CAD", "AUD", "BRL"].map((c) => ({ value: c, label: c }));

export function SourcesView({ workspaceId, appId, focus }: { workspaceId: string; appId: string; focus?: SourcesFocus }) {
  const invalidate = useInvalidate();
  const refresh = () => invalidate(wsPath(workspaceId, `/apps/${appId}`), wsPath(workspaceId, "/imports"));
  return (
    <div className="space-y-12">
      <RevenueCatSection workspaceId={workspaceId} appId={appId} onChanged={refresh} highlight={focus === "revenuecat"} />
      <CsvImportSection workspaceId={workspaceId} appId={appId} onChanged={refresh} highlight={focus === "csv"} />
      <ManualEntrySection workspaceId={workspaceId} appId={appId} onChanged={refresh} highlight={focus === "manual"} />
      <TrackedLinksSection workspaceId={workspaceId} appId={appId} highlight={focus === "links"} />
    </div>
  );
}

function useAppCampaigns(workspaceId: string, appId: string) {
  return useApiQuery<Page<Campaign>>(wsPath(workspaceId, `/apps/${appId}/campaigns`), { retry: false });
}

// ---------------------------------------------------------------------------
// RevenueCat
// ---------------------------------------------------------------------------

function RevenueCatSection({ workspaceId, appId, onChanged, highlight }: { workspaceId: string; appId: string; onChanged: () => void; highlight?: boolean }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const conns = useApiQuery<Page<ConnectedAccount>>(wsPath(workspaceId, `/apps/${appId}/analytics/connections`));
  const [secretKey, setSecretKey] = useState("");
  const [projectId, setProjectId] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [busy, setBusy] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(workspaceId, jobId, {
    onSettled: (j) => {
      void conns.refetch();
      onChanged();
      if (j.status === "succeeded") toast.success("RevenueCat synced", "Numbers are labelled RevenueCat (API) with each metric's definition.");
    },
  });
  const rc = conns.data?.items.filter((c) => c.provider === "revenuecat") ?? [];
  const others = conns.data?.items.filter((c) => c.provider !== "revenuecat") ?? [];

  const connect = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ account: ConnectedAccount; job: Job }>(wsPath(workspaceId, `/apps/${appId}/analytics/revenuecat`), { secretKey: secretKey.trim(), projectId: projectId.trim(), currency });
      setSecretKey("");
      setJobId(res.job.id);
      void conns.refetch();
    } catch (err) {
      toast.error("RevenueCat didn’t connect", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const sync = async (id: string) => {
    try {
      const res = await api.post<{ job: Job }>(wsPath(workspaceId, `/analytics/connections/${id}/sync`), {}, { idempotent: true });
      setJobId(res.job.id);
    } catch (err) {
      toast.error("Sync didn’t start", errorMessage(err));
    }
  };
  const disconnect = async (id: string) => {
    try {
      await api.del(wsPath(workspaceId, `/analytics/connections/${id}`));
      void conns.refetch();
      toast.success("Disconnected", "The key was deleted. Numbers already synced stay, labelled with their sync date.");
    } catch (err) {
      toast.error("Couldn’t disconnect", errorMessage(err));
    }
  };

  return (
    <Section title="RevenueCat" description="Subscriptions, trials and revenue from your own RevenueCat project. Account-level numbers: they aren't attributed to a specific post." className={highlight ? "scroll-mt-24" : undefined}>
      {rc.map((c) => (
        <Card key={c.id} className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 space-y-1">
            <p className="flex items-center gap-2 text-body-sm font-medium">
              {c.displayName} <StatusPill status={statusKindOf(c.status === "connected" ? "succeeded" : c.status === "revoked" ? "cancelled" : "failed")}>{c.status}</StatusPill>
            </p>
            <p className="text-footnote text-ink-2">Last sync: {c.lastSyncAt ? `${fmtDate(c.lastSyncAt, true)} UTC` : "not yet"}</p>
            {c.lastError ? <p className="text-footnote text-ink-3">{c.lastError}</p> : null}
          </div>
          {c.status !== "revoked" ? (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" icon={<RefreshCw aria-hidden />} onClick={() => void sync(c.id)} disabled={c.status !== "connected" || !can("analytics.write")}>
                Sync now
              </Button>
              {can("accounts.manage") ? (
                <Button size="sm" variant="ghost" onClick={() => void disconnect(c.id)}>
                  Disconnect
                </Button>
              ) : null}
            </div>
          ) : null}
        </Card>
      ))}
      {jobId ? <JobProgress job={job.job} title="Syncing RevenueCat" onRetry={() => void job.retry()} retrying={job.retrying} /> : null}
      {can("accounts.manage") ? (
        <Card className="space-y-4">
          <p className="flex items-center gap-2 text-body-sm font-medium">
            <KeyRound className="size-4 text-ink-2" aria-hidden /> {rc.length ? "Replace key or add a project" : "Connect a project"}
          </p>
          <div className="grid gap-4 sm:grid-cols-[2fr_1fr_8rem]">
            <Field label="Secret API key (v2)" hint="Needs Charts & Metrics read permission. Stored encrypted; never shown again.">
              {(ids) => <Input id={ids.id} aria-describedby={ids.describedBy} type="password" autoComplete="off" value={secretKey} onChange={(e) => setSecretKey(e.target.value)} placeholder="sk_…" />}
            </Field>
            <Field label="Project ID">{(ids) => <Input id={ids.id} value={projectId} onChange={(e) => setProjectId(e.target.value)} placeholder="proj…" />}</Field>
            <Field label="Currency">{(ids) => <Select id={ids.id} options={CURRENCIES} value={currency} onChange={(e) => setCurrency(e.target.value)} />}</Field>
          </div>
          <Button onClick={() => void connect()} loading={busy} disabled={secretKey.trim().length < 8 || !projectId.trim()}>
            Connect and sync
          </Button>
        </Card>
      ) : (
        <Notice>Only members who can manage accounts can connect RevenueCat.</Notice>
      )}
      {others.length ? (
        <p className="text-footnote text-ink-2">
          Other connected accounts: {others.map((o) => `${o.displayName} (${o.status}${o.capabilities.includes("read_insights") ? ", insights" : ""})`).join(", ")}. Automatic social insights aren't available in the beta; import or enter post numbers.
        </p>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// CSV import
// ---------------------------------------------------------------------------

const TARGETS = [
  { value: "ignore", label: "Ignore" },
  { value: "date", label: "Date" },
  { value: "end_date", label: "End date" },
  { value: "metric", label: "Metric name (long format)" },
  { value: "value", label: "Value (long format)" },
  { value: "currency", label: "Currency" },
  { value: "channel", label: "Channel" },
  ...MetricName.options.map((m) => ({ value: `metric:${m}`, label: `Metric: ${m.replace(/_/g, " ")}` })),
];

const FORMAT_LABEL: Record<string, string> = {
  app_store_sales: "App Store Connect sales report",
  play_installs: "Google Play Console installs report",
  generic_long: "Spreadsheet (date, metric, value rows)",
  generic_wide: "Spreadsheet (one column per metric)",
};

function CsvImportSection({ workspaceId, appId, onChanged, highlight }: { workspaceId: string; appId: string; onChanged: () => void; highlight?: boolean }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const fileRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<"idle" | "uploading" | "parsing">("idle");
  const [pct, setPct] = useState(0);
  const [preview, setPreview] = useState<ImportPreviewResponse | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [options, setOptions] = useState<ImportOptions>({});
  const [jobId, setJobId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const history = useApiQuery<Page<ImportBatch>>(wsPath(workspaceId, `/apps/${appId}/imports`));
  const job = useJob(workspaceId, jobId, {
    onSettled: (j) => {
      void history.refetch();
      onChanged();
      if (j.status === "succeeded") {
        toast.success("Import complete", "Imported numbers are labelled “Imported” wherever they appear.");
        setPreview(null);
      }
    },
  });

  const onFile = async (file: File) => {
    setStage("uploading");
    setPct(0);
    try {
      const mimeType = /\.csv$/i.test(file.name) ? "text/csv" : "text/plain";
      const up = await api.post<UploadResponse>(wsPath(workspaceId, "/uploads"), { filename: file.name, mimeType, bytes: file.size, role: "document", appId });
      await uploadToSignedUrl(up.upload, file, setPct);
      await api.post<CompleteUploadResponse>(wsPath(workspaceId, `/assets/${up.asset.id}/complete`));
      setStage("parsing");
      const res = await api.post<ImportPreviewResponse>(wsPath(workspaceId, `/apps/${appId}/imports`), { assetId: up.asset.id });
      setPreview(res);
      setMapping(res.batch.mapping);
      setOptions(res.batch.options);
    } catch (err) {
      toast.error("Couldn’t read that file", errorMessage(err));
    } finally {
      setStage("idle");
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remap = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      const res = await api.patch<{ batch: ImportBatch }>(wsPath(workspaceId, `/imports/${preview.batch.id}`), { mapping, options });
      setPreview({ ...preview, batch: res.batch });
    } catch (err) {
      toast.error("Couldn’t update the preview", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const commit = async () => {
    if (!preview) return;
    setSaving(true);
    try {
      const res = await api.post<ImportCommitResponse>(wsPath(workspaceId, `/imports/${preview.batch.id}/commit`), { mapping, options }, { idempotencyKey: newIdempotencyKey("imp") });
      setJobId(res.job.id);
    } catch (err) {
      toast.error("Import didn’t start", errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (id: string) => {
    try {
      const r = await api.del<{ deleted: number }>(wsPath(workspaceId, `/imports/${id}`));
      toast.success("Import removed", `${r.deleted} imported observations were deleted.`);
      void history.refetch();
      onChanged();
    } catch (err) {
      toast.error("Couldn’t remove the import", errorMessage(err));
    }
  };

  const batch = preview?.batch;
  const presetFormat = batch?.detectedFormat === "app_store_sales" || batch?.detectedFormat === "play_installs";
  return (
    <Section
      title="Import a CSV"
      description="App Store Connect sales reports, Google Play installs reports, or your own spreadsheet. You check the mapping before anything is saved."
      className={highlight ? "scroll-mt-24" : undefined}
      actions={
        can("analytics.write") ? (
          <>
            <input ref={fileRef} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" className="sr-only" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} aria-label="Choose a CSV file" />
            <Button size="sm" icon={<FileUp aria-hidden />} loading={stage !== "idle"} onClick={() => fileRef.current?.click()}>
              {stage === "uploading" ? `Uploading ${pct}%` : stage === "parsing" ? "Reading…" : "Choose file"}
            </Button>
          </>
        ) : null
      }
    >
      {batch ? (
        <Card className="space-y-5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-body-sm font-medium">{batch.filename}</span>
            <Badge>{FORMAT_LABEL[batch.detectedFormat ?? "generic_wide"]}</Badge>
            <span className="text-footnote text-ink-2">
              {batch.rowCount} rows · {batch.acceptedCount} usable · {batch.rejected.length} rejected
            </span>
          </div>
          {preview?.warnings.map((w) => (
            <Notice key={w} tone="warning">
              {w}
            </Notice>
          ))}
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Timezone" hint="Calendar days in the file are read in this zone.">
              {(ids) => <Input id={ids.id} value={options.timezone ?? ""} onChange={(e) => setOptions({ ...options, timezone: e.target.value })} placeholder="UTC" />}
            </Field>
            <Field label="Date format">
              {(ids) => (
                <Select id={ids.id} value={options.dateFormat ?? "auto"} onChange={(e) => setOptions({ ...options, dateFormat: e.target.value as ImportOptions["dateFormat"] })} options={[{ value: "auto", label: "Detect" }, { value: "YMD", label: "2026-10-27" }, { value: "MDY", label: "10/27/2026 (MDY)" }, { value: "DMY", label: "27/10/2026 (DMY)" }]} />
              )}
            </Field>
            <Field label="Currency" hint="For money columns without a currency.">
              {(ids) => <Select id={ids.id} value={options.currency ?? ""} onChange={(e) => setOptions({ ...options, currency: e.target.value || undefined })} options={[{ value: "", label: "From file" }, ...CURRENCIES]} />}
            </Field>
            <Field label="Channel" hint="Applies to rows without a channel.">
              {(ids) => <Select id={ids.id} value={options.channel ?? ""} onChange={(e) => setOptions({ ...options, channel: (e.target.value || undefined) as Channel | undefined })} options={[{ value: "", label: "None" }, ...CHANNEL_OPTIONS]} />}
            </Field>
          </div>
          <Field label="What are these numbers?" optional hint="Shown next to every imported value, e.g. “TikTok analytics export, video views”.">
            {(ids) => <Input id={ids.id} value={options.definitionNote ?? ""} maxLength={300} onChange={(e) => setOptions({ ...options, definitionNote: e.target.value || undefined })} />}
          </Field>
          {!presetFormat ? (
            <div className="space-y-2">
              <p className="text-footnote font-medium text-ink-2">Columns</p>
              <div className="grid gap-2 sm:grid-cols-2">
                {batch.columns.map((col) => (
                  <label key={col} className="flex items-center justify-between gap-3 rounded-lg bg-mist px-3 py-2 text-body-sm">
                    <span className="truncate font-medium">{col}</span>
                    <span className="w-56 shrink-0">
                      <Select selectSize="sm" aria-label={`Map column ${col}`} value={mapping[col] ?? "ignore"} onChange={(e) => setMapping({ ...mapping, [col]: e.target.value })} options={mapping[col] && !TARGETS.some((t) => t.value === mapping[col]) ? [{ value: mapping[col]!, label: mapping[col]! }, ...TARGETS] : TARGETS} />
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-footnote text-ink-2">This is a recognised store report, so its columns are read using the store's own definitions (shown next to each number).</p>
          )}
          <div className="grid gap-5 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-footnote font-medium text-ink-2">Preview (first rows)</p>
              {batch.preview.length ? (
                <table className="w-full text-left text-footnote">
                  <thead className="text-ink-3">
                    <tr>
                      <th className="py-1 font-medium">Day</th>
                      <th className="py-1 font-medium">Metric</th>
                      <th className="py-1 text-right font-medium">Value</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {batch.preview.map((r, i) => (
                      <tr key={i}>
                        <td className="py-1 tabular">{r.date}</td>
                        <td className="py-1">
                          {r.metric.replace(/_/g, " ")}
                          {r.channel ? <span className="text-ink-3"> · {CHANNEL_LABEL[r.channel as Channel] ?? r.channel}</span> : null}
                        </td>
                        <td className="py-1 text-right tabular">
                          {r.value} {r.currency ?? ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-footnote text-ink-3">No usable rows with this mapping.</p>
              )}
            </div>
            <div>
              <p className="mb-2 text-footnote font-medium text-ink-2">Rejected rows</p>
              {batch.rejected.length ? (
                <ul className="max-h-56 space-y-1 overflow-auto text-footnote">
                  {batch.rejected.map((r, i) => (
                    <li key={i} className="text-ink-2">
                      <span className="tabular text-ink-3">Row {r.row}:</span> {r.reason}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-footnote text-ink-3">None.</p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => void remap()} loading={saving && !jobId}>
              Update preview
            </Button>
            <Button onClick={() => void commit()} loading={saving} disabled={!batch.preview.length || Boolean(jobId && job.job && !["succeeded", "failed", "cancelled"].includes(job.job.status))}>
              Import {batch.acceptedCount} rows
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              Cancel
            </Button>
          </div>
          {jobId ? <JobProgress job={job.job} title="Importing" onRetry={() => void job.retry()} retrying={job.retrying} /> : null}
        </Card>
      ) : null}
      {history.data?.items.length ? (
        <Card padding="none">
          <ul className="divide-y divide-line">
            {history.data.items.slice(0, 10).map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-body-sm">
                <span className="min-w-0">
                  <span className="font-medium">{b.kind === "manual" ? "Manual entry" : b.filename}</span>
                  <span className="ml-2 text-footnote text-ink-2">
                    {fmtDate(b.createdAt)} · {b.kind === "manual" ? b.options.definitionNote : `${b.observationCount ?? 0} observations, ${b.rejected.length} rejected rows`}
                  </span>
                  {b.error ? <span className="block text-footnote text-ink-3">{b.error}</span> : null}
                </span>
                <span className="flex items-center gap-2">
                  <StatusPill status={statusKindOf(b.status === "committed" ? "succeeded" : b.status === "failed" ? "failed" : "queued")}>{b.status}</StatusPill>
                  {b.status === "committed" && can("analytics.write") ? (
                    <Button size="sm" variant="ghost" icon={<Undo2 aria-hidden />} onClick={() => void rollback(b.id)}>
                      Remove
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Manual entry
// ---------------------------------------------------------------------------

function ManualEntrySection({ workspaceId, appId, onChanged, highlight }: { workspaceId: string; appId: string; onChanged: () => void; highlight?: boolean }) {
  const toast = useToast();
  const { can } = useWorkspace();
  const campaigns = useAppCampaigns(workspaceId, appId);
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ metric: "views", value: "", currency: "USD", from: today, to: today, channel: "", campaignId: "", attribution: "aggregate", definition: "" });
  const [busy, setBusy] = useState(false);
  const money = ["revenue", "mrr", "ad_spend", "content_cost"].includes(f.metric);
  if (!can("analytics.write")) return null;
  const submit = async () => {
    setBusy(true);
    try {
      const end = new Date(`${f.to}T00:00:00Z`).getTime() + 86_400_000;
      await api.post<{ observation: MetricObservation }>(wsPath(workspaceId, `/apps/${appId}/observations`), {
        metric: f.metric,
        value: Number(f.value),
        currency: money ? f.currency : undefined,
        windowStart: `${f.from}T00:00:00Z`,
        windowEnd: new Date(end).toISOString(),
        channel: f.channel || undefined,
        campaignId: f.campaignId || undefined,
        attribution: f.attribution,
        definition: f.definition,
      });
      toast.success("Saved", "This number is labelled “Manual” everywhere it appears.");
      setF({ ...f, value: "" });
      onChanged();
    } catch (err) {
      toast.error("Couldn’t save", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Enter numbers manually" description="For stats you can only see inside an app (e.g. Instagram insights). Labelled “Manual”; never treated as live data." className={highlight ? "scroll-mt-24" : undefined}>
      <Card className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Metric">{(ids) => <Select id={ids.id} options={METRIC_OPTIONS} value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })} />}</Field>
          <Field label={money ? "Amount" : "Value"}>{(ids) => <Input id={ids.id} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />}</Field>
          {money ? <Field label="Currency">{(ids) => <Select id={ids.id} options={CURRENCIES} value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })} />}</Field> : null}
          <Field label="Channel" optional>
            {(ids) => <Select id={ids.id} options={[{ value: "", label: "None" }, ...CHANNEL_OPTIONS]} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })} />}
          </Field>
          <Field label="From (UTC day)">{(ids) => <Input id={ids.id} type="date" max={today} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />}</Field>
          <Field label="To (UTC day, inclusive)">{(ids) => <Input id={ids.id} type="date" max={today} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />}</Field>
          {campaigns.data?.items.length ? (
            <Field label="Campaign" optional>
              {(ids) => <Select id={ids.id} options={[{ value: "", label: "None" }, ...campaigns.data!.items.map((c) => ({ value: c.id, label: c.name }))]} value={f.campaignId} onChange={(e) => setF({ ...f, campaignId: e.target.value })} />}
            </Field>
          ) : null}
          <Field label="Scope">
            {(ids) => (
              <Select
                id={ids.id}
                value={f.attribution}
                onChange={(e) => setF({ ...f, attribution: e.target.value })}
                options={[
                  { value: "aggregate", label: "Whole account" },
                  { value: "platform_reported", label: "One specific post (platform stats)" },
                  { value: "none", label: "Unattributed" },
                ]}
              />
            )}
          </Field>
        </div>
        <Field label="Where does this number come from?" hint="Shown as the definition, e.g. “Instagram app → Insights → Reel plays”.">
          {(ids) => <Input id={ids.id} value={f.definition} maxLength={300} onChange={(e) => setF({ ...f, definition: e.target.value })} />}
        </Field>
        <Button icon={<PenLine aria-hidden />} onClick={() => void submit()} loading={busy} disabled={!f.value.trim() || Number.isNaN(Number(f.value)) || f.definition.trim().length < 3 || f.to < f.from}>
          Save number
        </Button>
      </Card>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Tracked links
// ---------------------------------------------------------------------------

type LinkWithUrl = AttributionLink & { publicUrl: string };

function TrackedLinksSection({ workspaceId, appId, highlight }: { workspaceId: string; appId: string; highlight?: boolean }) {
  const toast = useToast();
  const { can, app } = useWorkspace();
  const campaigns = useAppCampaigns(workspaceId, appId);
  const links = useApiQuery<Page<LinkWithUrl>>(wsPath(workspaceId, `/apps/${appId}/links`));
  const [f, setF] = useState({ campaignId: "", destination: "website", url: "", confirm: false, source: "", medium: "social", content: "", slug: "", channel: "" });
  const [busy, setBusy] = useState(false);
  const destinations = [
    ...(app?.storeUrls.ios ? [{ value: "ios", label: "App Store page" }] : []),
    ...(app?.storeUrls.android ? [{ value: "android", label: "Google Play page" }] : []),
    ...(app?.websiteUrl ? [{ value: "website", label: "Website" }] : []),
    { value: "custom", label: "Another URL…" },
  ];
  const create = async () => {
    setBusy(true);
    try {
      const body = {
        ...(f.destination === "custom" ? { destinationUrl: f.url.trim(), confirmExternalDestination: f.confirm } : { destination: f.destination }),
        utm: { source: f.source.trim(), medium: f.medium.trim(), content: f.content.trim() || undefined },
        slug: f.slug.trim() || undefined,
        channel: f.channel || undefined,
      };
      const res = await api.post<{ link: AttributionLink; publicUrl: string }>(wsPath(workspaceId, `/campaigns/${f.campaignId}/links`), body);
      await navigator.clipboard?.writeText(res.publicUrl).catch(() => {});
      toast.success("Link created", `${res.publicUrl} (copied)`);
      void links.refetch();
    } catch (err) {
      toast.error("Couldn’t create the link", errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (l: LinkWithUrl) => {
    try {
      await api.patch(wsPath(workspaceId, `/links/${l.id}`), { active: !l.active });
      void links.refetch();
    } catch (err) {
      toast.error("Couldn’t update the link", errorMessage(err));
    }
  };
  const campaignName = (id: string) => campaigns.data?.items.find((c) => c.id === id)?.name ?? id;
  return (
    <Section title="Tracked links" description="Short links that count clicks per campaign (link-level attribution). No cookies or IP addresses are stored; link-preview bots aren't counted." className={highlight ? "scroll-mt-24" : undefined}>
      {can("analytics.write") ? (
        campaigns.data?.items.length ? (
          <Card className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Campaign">
                {(ids) => <Select id={ids.id} placeholder="Choose…" options={campaigns.data!.items.map((c) => ({ value: c.id, label: c.name }))} value={f.campaignId} onChange={(e) => setF({ ...f, campaignId: e.target.value })} />}
              </Field>
              <Field label="Destination">{(ids) => <Select id={ids.id} options={destinations} value={f.destination} onChange={(e) => setF({ ...f, destination: e.target.value })} />}</Field>
              <Field label="Posted on" optional>
                {(ids) => <Select id={ids.id} options={[{ value: "", label: "—" }, ...CHANNEL_OPTIONS]} value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value, source: f.source || e.target.value })} />}
              </Field>
              {f.destination === "custom" ? (
                <Field label="URL" className="sm:col-span-2 lg:col-span-3">
                  {(ids) => <Input id={ids.id} type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://" />}
                </Field>
              ) : null}
              <Field label="utm_source">{(ids) => <Input id={ids.id} value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} placeholder="tiktok" />}</Field>
              <Field label="utm_medium">{(ids) => <Input id={ids.id} value={f.medium} onChange={(e) => setF({ ...f, medium: e.target.value })} />}</Field>
              <Field label="utm_content" optional>{(ids) => <Input id={ids.id} value={f.content} onChange={(e) => setF({ ...f, content: e.target.value })} placeholder="hook-a" />}</Field>
              <Field label="Short name" optional hint="4–40 lowercase letters, digits or dashes.">
                {(ids) => <Input id={ids.id} value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} placeholder="launch-week" />}
              </Field>
            </div>
            {f.destination === "custom" ? (
              <Checkbox checked={f.confirm} onCheckedChange={(v) => setF({ ...f, confirm: v })} label="I confirm this destination" description="It isn't one of your app's own store pages or website, so visitors first see a “You're leaving to this site” page (MuseLaunch never redirects silently to outside sites)." />
            ) : null}
            <Button icon={<Link2 aria-hidden />} onClick={() => void create()} loading={busy} disabled={!f.campaignId || !f.source.trim() || !f.medium.trim() || (f.destination === "custom" && (!f.url || !f.confirm))}>
              Create link
            </Button>
          </Card>
        ) : (
          <Notice>Tracked links belong to a campaign. Create a campaign in Creator first.</Notice>
        )
      ) : null}
      {links.data?.items.length ? (
        <Card padding="none">
          <ul className="divide-y divide-line">
            {links.data.items.map((l) => (
              <li key={l.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-body-sm font-medium">
                    <span className="truncate">{l.publicUrl.replace(/^https?:\/\//, "")}</span>
                    <button type="button" aria-label="Copy link" className="text-ink-3 hover:text-ink" onClick={() => void navigator.clipboard?.writeText(l.publicUrl)}>
                      <Copy className="size-3.5" aria-hidden />
                    </button>
                  </p>
                  <p className="truncate text-footnote text-ink-2">
                    {campaignName(l.campaignId)} → {l.destinationKind === "other" ? "external (confirmed)" : l.destinationKind} · utm_source={l.utm.source}
                    {l.utm.content ? ` · ${l.utm.content}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-3 text-footnote">
                  <span className="tabular">
                    <span className="font-semibold text-ink">{l.clickCount}</span> clicks
                  </span>
                  {l.uaClassCounts.bot ? <span className="text-ink-3 tabular">{l.uaClassCounts.bot} bot previews not counted</span> : null}
                  {can("analytics.write") ? (
                    <Button size="sm" variant="ghost" onClick={() => void toggle(l)}>
                      {l.active ? "Pause" : "Resume"}
                    </Button>
                  ) : (
                    <Badge tone="outline">{l.active ? "Active" : "Paused"}</Badge>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </Section>
  );
}
