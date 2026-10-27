"use client";
import type { BrandFinding, BrandReview } from "@muselaunch/contracts";
import { Badge, StatusPill, Tooltip, cn, type StatusKind } from "@muselaunch/ui";
import { BadgeCheck, Brain, BookOpen, Cpu, ShieldHalf } from "lucide-react";
import type { GlimmerInfo, ReviewBrief } from "./use-guardian";

export const CATEGORY_LABEL: Record<BrandFinding["category"], string> = {
  tone: "Tone",
  claim: "Claim",
  prohibited: "Prohibited",
  palette: "Palette",
  typography: "Typography",
  logo: "Logo",
  cta: "CTA",
  consistency: "Consistency",
  accessibility: "Readability",
  privacy: "Privacy",
  platform_fit: "Platform fit",
};

export const SEVERITY_LABEL: Record<BrandFinding["severity"], string> = { block: "Blocking", warn: "Warnings", info: "Notes" };

const STATUS: Record<BrandReview["status"], { kind: StatusKind; label: string }> = {
  queued: { kind: "queued", label: "Queued" },
  running: { kind: "running", label: "Reviewing" },
  passed: { kind: "success", label: "On brand" },
  warnings: { kind: "attention", label: "Warnings" },
  blocked: { kind: "failed", label: "Blocked" },
  failed: { kind: "failed", label: "Review failed" },
};

export function ReviewStatus({ status, className }: { status: BrandReview["status"]; className?: string }) {
  const s = STATUS[status];
  return (
    <StatusPill status={s.kind} className={className}>
      {s.label}
    </StatusPill>
  );
}

/** `Local · Muse Glimmer (RTX 5090)` when Glimmer reviewed it; `Rules only — Glimmer offline` otherwise. Never guesses. */
export function EngineBadge({ reviewer, glimmer, className }: { reviewer?: Pick<BrandReview["reviewer"], "engine" | "label" | "note"> | Pick<ReviewBrief, "engine" | "label" | "note"> | null; glimmer?: GlimmerInfo | null; className?: string }) {
  const engine = reviewer?.engine ?? (glimmer ? (glimmer.configured ? "glimmer" : "rules") : undefined);
  if (!engine) return null;
  const label = (reviewer?.label ?? glimmer?.label ?? "").trim();
  if (engine === "glimmer")
    return (
      <Badge tone="accent" icon={<Cpu aria-hidden />} className={className} title="Muse Glimmer runs on your own GPU: reviews stay private and fast. Deterministic brand rules run too.">
        Local · Muse Glimmer{label ? ` (${label})` : ""}
      </Badge>
    );
  return (
    <Badge tone="neutral" icon={<ShieldHalf aria-hidden />} className={className} title={reviewer?.note ?? "Muse Glimmer isn't connected, so only the deterministic brand rules run."}>
      Rules only — Glimmer offline
    </Badge>
  );
}

export function SourceTag({ source }: { source: BrandFinding["source"] }) {
  return <span className={cn("rounded px-1.5 py-px text-[11px] font-medium leading-4", source === "glimmer" ? "bg-accent-soft text-accent-ink" : "bg-mist-2 text-ink-2")}>{source === "glimmer" ? "Glimmer" : "Rules"}</span>;
}

export function EvidenceChips({ finding, claim, preference }: { finding: BrandFinding; claim: (id: string) => { text: string } | null; preference: (id: string) => { text: string } | null }) {
  const { claimIds, preferenceIds, guideline } = finding.evidence;
  if (!claimIds.length && !preferenceIds.length && !guideline) return null;
  const chip = "inline-flex max-w-full items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5 text-caption text-ink-2 [&_svg]:size-3";
  return (
    <div className="flex flex-wrap gap-1.5">
      {claimIds.map((id) => (
        <Tooltip key={id} content={claim(id)?.text ?? id}>
          <span className={chip} tabIndex={0}>
            <BadgeCheck aria-hidden />
            <span className="truncate">{claim(id) ? `Claim: ${truncate(claim(id)!.text, 34)}` : "Verified claim"}</span>
          </span>
        </Tooltip>
      ))}
      {preferenceIds.map((id) => (
        <Tooltip key={id} content={preference(id)?.text ?? "Remembered preference"}>
          <span className={chip} tabIndex={0}>
            <Brain aria-hidden />
            <span className="truncate">{preference(id) ? `Memory: ${truncate(preference(id)!.text, 34)}` : "Team memory"}</span>
          </span>
        </Tooltip>
      ))}
      {guideline ? (
        <Tooltip content={guideline}>
          <span className={chip} tabIndex={0}>
            <BookOpen aria-hidden />
            <span className="truncate">{truncate(guideline, 40)}</span>
          </span>
        </Tooltip>
      ) : null}
    </div>
  );
}

export const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatLatency(ms?: number) {
  if (ms === undefined) return null;
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

export function relTime(iso?: string) {
  if (!iso) return null;
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}
