"use client";
import { EmptyState, ErrorState, Skeleton } from "@muselaunch/ui";
import { Construction } from "lucide-react";
import type { ReactNode } from "react";
import { errorMessage, isRouteMissing, type ApiError } from "@/lib/api";

/** Shown when a backend module's endpoint hasn't shipped in this build (honest, not an error). */
export function UnavailableState({ feature, description, className }: { feature: string; description?: ReactNode; className?: string }) {
  return (
    <EmptyState
      className={className}
      icon={<Construction aria-hidden />}
      title="Not available in this build yet"
      description={description ?? `The service behind ${feature} hasn’t been deployed yet. Nothing is simulated in the meantime.`}
    />
  );
}

/**
 * Standard loading / missing-route / error / content switch for a query.
 * `skeleton` renders while loading; errors get a retry.
 */
export function QueryState<T>({
  query,
  feature,
  skeleton,
  children,
  unavailable,
}: {
  query: { data: T | undefined; error: ApiError | null; isLoading: boolean; isFetching: boolean; refetch: () => unknown };
  feature: string;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
  unavailable?: ReactNode;
}) {
  if (query.isLoading) return <>{skeleton ?? <DefaultSkeleton />}</>;
  if (query.error) {
    if (isRouteMissing(query.error)) return <>{unavailable ?? <UnavailableState feature={feature} />}</>;
    return <ErrorState title={`${feature} didn’t load`} message={errorMessage(query.error)} onRetry={() => void query.refetch()} retrying={query.isFetching} reference={query.error.requestId} />;
  }
  if (query.data === undefined) return null;
  return <>{children(query.data)}</>;
}

function DefaultSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-16 w-full" rounded="xl" />
      <Skeleton className="h-16 w-full" rounded="xl" />
      <Skeleton className="h-16 w-4/5" rounded="xl" />
    </div>
  );
}
