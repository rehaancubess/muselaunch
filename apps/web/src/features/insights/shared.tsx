"use client";
import type { AttributionLevel, ImportBatch, InsightMetric, Job, MetricObservation, MetricSourceValue } from "@muselaunch/contracts";
import { Badge, ProvenanceBadge, Tooltip } from "@muselaunch/ui";
import { Info } from "lucide-react";
import type { ReactNode } from "react";

/** Response shapes for module F routes (composed from contract types). */
export type ImportPreviewResponse = { batch: ImportBatch; warnings: string[]; observationsPreviewCount: number };
export type ImportCommitResponse = { batch: ImportBatch; job: Job };
export type ObservationsPage = { items: MetricObservation[]; nextCursor: string | null };

export const ATTRIBUTION_LABEL: Record<AttributionLevel, { label: string; help: string }> = {
  direct: { label: "Directly attributed", help: "User-level attribution from the source (e.g. a campaign attribute on the subscriber)." },
  link: { label: "Via tracked link", help: "Measured through a MuseLaunch tracked link: these people clicked this campaign's link." },
  platform_reported: { label: "Platform-reported", help: "The platform reports this number for the specific post." },
  aggregate: { label: "Account-level", help: "Account-wide total for the period. It isn't attributed to any post or campaign; changes are correlations, not proof of cause." },
  none: { label: "Unattributed", help: "Not tied to any campaign or post." },
};

export function AttributionBadge({ level }: { level: AttributionLevel | null }) {
  if (!level) return null;
  const a = ATTRIBUTION_LABEL[level];
  return (
    <Badge tone={level === "aggregate" || level === "none" ? "outline" : "neutral"} title={a.help}>
      {a.label}
    </Badge>
  );
}

/** Imported / Manual / Tracked link / API — never "live" for imported data. */
export function SourceBadge({ source }: { source: Pick<MetricSourceValue, "source" | "imported" | "label"> }) {
  if (source.source === "manual") return <ProvenanceBadge kind="manual" detail="Entered by a person" />;
  if (source.source === "tracked_link") return <ProvenanceBadge kind="link" />;
  if (source.imported) return <ProvenanceBadge kind="imported" label="Imported" detail={`${source.label} — imported file, not a live connection`} />;
  return (
    <Badge tone="neutral" title={`Synced from ${source.label}`}>
      API
    </Badge>
  );
}

export function fmtNumber(v: number, unit: InsightMetric["unit"], currency?: string): string {
  if (unit === "currency") {
    try {
      return new Intl.NumberFormat(undefined, { style: "currency", currency: currency ?? "USD", maximumFractionDigits: Math.abs(v) >= 1000 ? 0 : 2 }).format(v);
    } catch {
      return `${v.toFixed(2)} ${currency ?? ""}`.trim();
    }
  }
  if (unit === "seconds") return v >= 3600 ? `${(v / 3600).toFixed(1)} h` : v >= 60 ? `${Math.round(v / 60)} min` : `${v} s`;
  if (unit === "percent") return `${v}%`;
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(v);
}

export function fmtDate(iso?: string | null, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString(undefined, withTime ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" } : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

export function Hint({ children, label = "Definition" }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip content={<div className="max-w-xs text-footnote">{children}</div>}>
      <button type="button" aria-label={label} className="inline-flex size-5 items-center justify-center rounded-full text-ink-3 hover:text-ink focus-visible:outline-none focus-visible:shadow-focus">
        <Info className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}

export function ConfidencePill({ confidence }: { confidence: "insufficient_data" | "low" | "medium" | "high" }) {
  const map = {
    insufficient_data: { label: "Insufficient data", tone: "outline" as const },
    low: { label: "Low confidence", tone: "warning" as const },
    medium: { label: "Medium confidence", tone: "neutral" as const },
    high: { label: "High confidence", tone: "success" as const },
  };
  const m = map[confidence];
  return <Badge tone={m.tone}>{m.label}</Badge>;
}

export function IdChips({ ids, max = 6 }: { ids: string[]; max?: number }) {
  if (!ids.length) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {ids.slice(0, max).map((id) => (
        <code key={id} className="rounded bg-mist px-1.5 py-0.5 font-mono text-caption text-ink-2" title="Observation backing this statement">
          {id}
        </code>
      ))}
      {ids.length > max ? <span className="text-caption text-ink-3">+{ids.length - max}</span> : null}
    </span>
  );
}
