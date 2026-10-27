"use client";
import { EmptyState } from "@muselaunch/ui";
import type { ReactNode } from "react";

/**
 * Shared placeholder used by feature folders until their owning module replaces the internals.
 * Honest by design: it says what will appear here; it never shows sample data.
 */
export function FeaturePlaceholder({ icon, title, description, children }: { icon: ReactNode; title: string; description: ReactNode; children?: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-line-strong bg-surface">
      <EmptyState size="lg" icon={icon} title={title} description={description} action={children} />
    </div>
  );
}
