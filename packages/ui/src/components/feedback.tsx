"use client";
import { AlertCircle, RotateCcw } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { cn } from "../cn";

export function Spinner({ size = 16, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={cn("animate-spin-slow text-ink-3", className)}
    >
      <circle cx="12" cy="12" r="9.5" fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2.5" />
      <path d="M21.5 12a9.5 9.5 0 0 0-9.5-9.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

/** Loading placeholder. Use shapes that match the content they stand in for. */
export function Skeleton({ className, style, rounded = "md" }: { className?: string; style?: CSSProperties; rounded?: "sm" | "md" | "lg" | "xl" | "full" }) {
  return (
    <div
      aria-hidden
      style={{
        backgroundImage: "linear-gradient(90deg, transparent 0, rgb(255 255 255 / 0.7) 50%, transparent 100%)",
        backgroundSize: "320px 100%",
        backgroundRepeat: "no-repeat",
        ...style,
      }}
      className={cn(
        "animate-shimmer bg-mist",
        rounded === "sm" && "rounded-sm",
        rounded === "md" && "rounded-md",
        rounded === "lg" && "rounded-lg",
        rounded === "xl" && "rounded-xl",
        rounded === "full" && "rounded-full",
        className,
      )}
    />
  );
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className="h-3.5" style={{ width: `${i === lines - 1 ? 60 : 100 - i * 6}%` }} />
      ))}
    </div>
  );
}

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  /** What will appear here, and how it gets here. */
  description?: ReactNode;
  action?: ReactNode;
  secondaryAction?: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}

/** Empty states explain what will appear and how. Never fill them with sample data. */
export function EmptyState({ icon, title, description, action, secondaryAction, className, size = "md" }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        size === "sm" && "gap-2 px-4 py-8",
        size === "md" && "gap-3 px-6 py-14",
        size === "lg" && "gap-4 px-6 py-24",
        className,
      )}
    >
      {icon ? (
        <div className={cn("flex items-center justify-center rounded-full bg-mist text-ink-2", size === "sm" ? "size-9 [&_svg]:size-4" : "size-12 [&_svg]:size-5")}>
          {icon}
        </div>
      ) : null}
      <div className="max-w-md space-y-1.5">
        <p className={cn("font-semibold text-ink", size === "lg" ? "text-title-3" : "text-headline")}>{title}</p>
        {description ? <div className="text-body-sm text-ink-2 text-pretty">{description}</div> : null}
      </div>
      {action || secondaryAction ? (
        <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
          {action}
          {secondaryAction}
        </div>
      ) : null}
    </div>
  );
}

export interface ErrorStateProps {
  title?: string;
  /** Safe user-facing message (API `userMessage`). */
  message?: string;
  onRetry?: () => void;
  retrying?: boolean;
  /** Request id or error code for support. */
  reference?: string;
  className?: string;
  compact?: boolean;
}

export function ErrorState({ title = "This didn't load", message, onRetry, retrying, reference, className, compact }: ErrorStateProps) {
  if (compact) {
    return (
      <div role="alert" className={cn("flex items-center gap-3 rounded-lg bg-danger-soft px-3.5 py-2.5 text-body-sm text-danger", className)}>
        <AlertCircle className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 text-pretty">{message ?? title}</span>
        {onRetry ? (
          <button type="button" onClick={onRetry} disabled={retrying} className="inline-flex items-center gap-1 font-medium hover:underline disabled:opacity-60">
            <RotateCcw className={cn("size-3.5", retrying && "animate-spin")} aria-hidden /> Try again
          </button>
        ) : null}
      </div>
    );
  }
  return (
    <div role="alert" className={cn("flex flex-col items-center justify-center gap-3 px-6 py-14 text-center", className)}>
      <div className="flex size-12 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertCircle className="size-5" aria-hidden />
      </div>
      <div className="max-w-md space-y-1.5">
        <p className="text-headline font-semibold">{title}</p>
        {message ? <p className="text-body-sm text-ink-2 text-pretty">{message}</p> : null}
        {reference ? <p className="text-caption text-ink-3 tabular">Reference {reference}</p> : null}
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="mt-1 inline-flex h-9 items-center gap-2 rounded-full bg-mist px-4 text-body-sm font-medium text-ink hover:bg-mist-2 disabled:opacity-60"
        >
          <RotateCcw className={cn("size-4", retrying && "animate-spin")} aria-hidden />
          Try again
        </button>
      ) : null}
    </div>
  );
}

export type NoticeTone = "neutral" | "info" | "success" | "warning" | "danger";

/** Inline, non-blocking notice (e.g. "Muse Image is restricted in your region"). */
export function Notice({ tone = "neutral", icon, title, children, action, className }: { tone?: NoticeTone; icon?: ReactNode; title?: ReactNode; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div
      role={tone === "danger" ? "alert" : "note"}
      className={cn(
        "flex items-start gap-3 rounded-lg px-4 py-3 text-body-sm",
        tone === "neutral" && "bg-mist text-ink-2",
        tone === "info" && "bg-accent-soft text-accent-ink",
        tone === "success" && "bg-success-soft text-success",
        tone === "warning" && "bg-warning-soft text-warning",
        tone === "danger" && "bg-danger-soft text-danger",
        className,
      )}
    >
      {icon ? <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span> : null}
      <div className="min-w-0 flex-1 space-y-0.5 text-pretty">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={cn(title && "opacity-90")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function ProgressBar({ value, className, tone = "accent", label }: { value: number | null; className?: string; tone?: "accent" | "success" | "danger" | "neutral"; label?: string }) {
  const pct = value == null ? null : Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-mist-2", className)}
    >
      <div
        className={cn(
          "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out",
          tone === "accent" && "bg-accent",
          tone === "success" && "bg-success",
          tone === "danger" && "bg-danger",
          tone === "neutral" && "bg-ink-3",
          pct == null && "w-1/3 animate-[ml-indeterminate_1.4s_var(--ml-ease-in-out)_infinite]",
        )}
        style={pct == null ? undefined : { width: `${Math.max(pct, 2)}%` }}
      />
      <style>{`@keyframes ml-indeterminate{0%{transform:translateX(-100%)}100%{transform:translateX(300%)}}`}</style>
    </div>
  );
}
