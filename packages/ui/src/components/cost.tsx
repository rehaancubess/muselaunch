"use client";
import { Coins } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "../cn";
import { Popover } from "./overlay";
import { Skeleton } from "./feedback";

export interface EstimateResult {
  credits: number;
  breakdown: { label: string; credits: number }[];
  available: number;
}

export interface CostEstimateViewProps {
  estimate: EstimateResult | null;
  loading?: boolean;
  error?: string | null;
  className?: string;
  /** Extra note (e.g. "Final renders are charged per 15 seconds"). */
  note?: ReactNode;
}

/** Shows credits for an action against the workspace balance, before the user commits. */
export function CostEstimateView({ estimate, loading, error, className, note }: CostEstimateViewProps) {
  if (loading && !estimate) {
    return (
      <div className={cn("flex items-center gap-2", className)} aria-busy>
        <Coins className="size-4 text-ink-3" aria-hidden />
        <Skeleton className="h-4 w-36" />
      </div>
    );
  }
  if (error) {
    return (
      <div className={cn("flex items-center gap-2 text-footnote text-ink-2", className)}>
        <Coins className="size-4 text-ink-3" aria-hidden />
        <span>Cost estimate unavailable. {error}</span>
      </div>
    );
  }
  if (!estimate) return null;
  const short = estimate.credits > estimate.available;
  return (
    <div className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-footnote", className)}>
      <Coins className={cn("size-4", short ? "text-danger" : "text-ink-2")} aria-hidden />
      <span className={cn("font-medium tabular", short ? "text-danger" : "text-ink")}>
        {estimate.credits === 0 ? "No credits" : `About ${estimate.credits.toLocaleString()} credit${estimate.credits === 1 ? "" : "s"}`}
      </span>
      <span className="tabular text-ink-2">of {estimate.available.toLocaleString()} available</span>
      {estimate.breakdown.length > 1 ? (
        <Popover
          label="Cost breakdown"
          align="start"
          className="w-72 p-3"
          trigger={
            <button type="button" className="text-footnote font-medium text-accent hover:underline">
              Breakdown
            </button>
          }
        >
          <ul className="space-y-1.5 text-footnote">
            {estimate.breakdown.map((b, i) => (
              <li key={i} className="flex justify-between gap-3">
                <span className="text-ink-2">{b.label}</span>
                <span className="tabular font-medium">{b.credits}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-line pt-2 text-caption text-ink-3">Estimates reserve credits when the job starts; unused credits are released when it finishes or fails.</p>
        </Popover>
      ) : null}
      {short ? <span className="w-full text-danger">Not enough credits for this action.</span> : null}
      {note ? <span className="w-full text-ink-3">{note}</span> : null}
    </div>
  );
}

export interface CostEstimateProps {
  operation: string;
  params?: Record<string, unknown>;
  /** Calls `POST /v1/workspaces/:wid/estimate`. */
  fetchEstimate: (req: { operation: string; params: Record<string, unknown> }) => Promise<EstimateResult>;
  onEstimate?: (e: EstimateResult | null) => void;
  className?: string;
  note?: ReactNode;
}

export function CostEstimate({ operation, params, fetchEstimate, onEstimate, className, note }: CostEstimateProps) {
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([operation, params ?? {}]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const t = setTimeout(() => {
      fetchEstimate({ operation, params: params ?? {} })
        .then((e) => {
          if (!alive) return;
          setEstimate(e);
          onEstimate?.(e);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setError(err instanceof Error ? err.message : "Try again later.");
          onEstimate?.(null);
        })
        .finally(() => alive && setLoading(false));
    }, 200);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return <CostEstimateView estimate={estimate} loading={loading} error={error} className={className} note={note} />;
}
