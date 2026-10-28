import { Ban, CircleDashed, Download, PenLine, Sparkles, Upload, Clapperboard, Image as ImageIcon, Film, Link2 } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "outline";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-mist text-ink-2",
  accent: "bg-accent-soft text-accent-ink",
  success: "bg-success-soft text-success",
  warning: "bg-warning-soft text-warning",
  danger: "bg-danger-soft text-danger",
  outline: "border border-line-strong text-ink-2",
};

export function Badge({ tone = "neutral", icon, children, className, title }: { tone?: BadgeTone; icon?: ReactNode; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={cn("inline-flex h-[22px] max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-caption font-medium [&_svg]:size-3 [&_svg]:shrink-0", TONE[tone], className)}
    >
      {icon}
      {/* Never wider than its container (phones): long labels truncate; `title` carries the full text. */}
      <span className="min-w-0 truncate">{children}</span>
    </span>
  );
}

export type StatusKind = "idle" | "queued" | "running" | "attention" | "success" | "failed" | "cancelled";

const STATUS_DOT: Record<StatusKind, string> = {
  idle: "bg-ink-3",
  queued: "bg-ink-3",
  running: "bg-accent animate-pulse-dot",
  attention: "bg-warning",
  success: "bg-success",
  failed: "bg-danger",
  cancelled: "bg-ink-3",
};

const STATUS_TONE: Record<StatusKind, BadgeTone> = {
  idle: "neutral",
  queued: "neutral",
  running: "accent",
  attention: "warning",
  success: "success",
  failed: "danger",
  cancelled: "neutral",
};

/** Status with a dot. Map entity statuses to a StatusKind with `statusKindOf`. */
export function StatusPill({ status, children, className }: { status: StatusKind; children: ReactNode; className?: string }) {
  return (
    <Badge tone={STATUS_TONE[status]} className={className}>
      <span aria-hidden className={cn("size-1.5 rounded-full", STATUS_DOT[status])} />
      {children}
    </Badge>
  );
}

/** Best-effort mapping of contract status strings (jobs, runs, campaigns, compositions, assets). */
export function statusKindOf(status: string): StatusKind {
  switch (status) {
    case "queued":
    case "pending":
    case "pending_upload":
    case "draft":
    case "proposed":
    case "planning":
      return "queued";
    case "running":
    case "fetching":
    case "analyzing":
    case "processing":
    case "rendering":
    case "producing":
    case "drafting":
    case "importing":
    case "uploaded":
      return "running";
    case "needs_approval":
    case "needs_review":
    case "awaiting_review":
    case "review":
    case "partial":
    case "concepts_ready":
      return "attention";
    case "succeeded":
    case "ready":
    case "rendered":
    case "approved":
    case "confirmed":
    case "verified":
    case "completed":
    case "produced":
    case "selected":
    case "live":
    case "connected":
      return "success";
    case "failed":
    case "error":
    case "rejected":
    case "invalid":
      return "failed";
    case "cancelled":
    case "archived":
    case "removed":
      return "cancelled";
    default:
      return "idle";
  }
}

export function humanizeStatus(status: string): string {
  const map: Record<string, string> = {
    needs_approval: "Needs approval",
    needs_review: "Needs review",
    pending_upload: "Uploading",
    concepts_ready: "Concepts ready",
    not_configured: "Not connected",
    manual_only: "Manual only",
    pending_approval: "Awaiting approval",
  };
  if (map[status]) return map[status];
  const s = status.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Where a piece of content or a capability comes from. Shown everywhere a user might
 * otherwise mistake imported, manual or unavailable data for live AI output.
 */
export type Provenance =
  | "live_ai"
  | "imported"
  | "manual"
  | "restricted"
  | "not_connected"
  | "generated"
  | "stock"
  | "upload"
  | "render"
  | "manual_only"
  | "pending_approval"
  | "link";

const PROVENANCE: Record<Provenance, { label: string; tone: BadgeTone; icon: ReactNode; help: string }> = {
  live_ai: { label: "Live AI", tone: "accent", icon: <Sparkles aria-hidden />, help: "Produced by a live model call" },
  imported: { label: "Imported", tone: "neutral", icon: <Download aria-hidden />, help: "Imported from a public listing, file or connected account" },
  manual: { label: "Manual", tone: "outline", icon: <PenLine aria-hidden />, help: "Entered or confirmed by a person" },
  restricted: { label: "Restricted", tone: "warning", icon: <Ban aria-hidden />, help: "Not available in this region or under the provider's terms" },
  not_connected: { label: "Not connected", tone: "neutral", icon: <CircleDashed aria-hidden />, help: "Not configured yet; nothing from this source is shown" },
  generated: { label: "AI generated", tone: "accent", icon: <ImageIcon aria-hidden />, help: "Generated media (never shown as your product UI)" },
  stock: { label: "Stock", tone: "neutral", icon: <Film aria-hidden />, help: "Licensed stock media" },
  upload: { label: "Uploaded", tone: "neutral", icon: <Upload aria-hidden />, help: "Uploaded by your team" },
  render: { label: "Rendered", tone: "neutral", icon: <Clapperboard aria-hidden />, help: "Rendered by MuseLaunch from a composition" },
  manual_only: { label: "Manual only", tone: "outline", icon: <PenLine aria-hidden />, help: "Available through manual steps only" },
  pending_approval: { label: "Awaiting approval", tone: "warning", icon: <CircleDashed aria-hidden />, help: "Waiting for third-party approval" },
  link: { label: "Tracked link", tone: "neutral", icon: <Link2 aria-hidden />, help: "Measured through a MuseLaunch tracked link" },
};

export function ProvenanceBadge({ kind, label, detail, className }: { kind: Provenance; label?: string; detail?: string; className?: string }) {
  const p = PROVENANCE[kind];
  return (
    <Badge tone={p.tone} icon={p.icon} className={className} title={detail ?? p.help}>
      {label ?? p.label}
    </Badge>
  );
}

/** Map a MediaAsset origin to a provenance badge kind. */
export function provenanceOfOrigin(origin: string): Provenance {
  switch (origin) {
    case "upload":
    case "recorded":
      return "upload";
    case "store_import":
    case "website_import":
      return "imported";
    case "generated":
      return "generated";
    case "stock":
      return "stock";
    case "render":
    case "derived":
      return "render";
    default:
      return "manual";
  }
}
