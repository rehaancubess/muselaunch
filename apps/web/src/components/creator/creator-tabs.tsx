"use client";
import { SegmentedControl, cn } from "@muselaunch/ui";
import { ChevronRight, Rocket } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageContainer } from "@/components/page-container";
import { useActiveAutopilot } from "@/components/shell/autopilot-chip";
import { isWorking } from "@/features/autopilot/types";
import { routes, type CreatorView } from "@/lib/routes";
import { useCurrentApp } from "@/lib/workspace";

const VIEWS: { value: CreatorView; label: string }[] = [
  { value: "make", label: "Make" },
  { value: "videos", label: "Videos" },
  { value: "scheduled", label: "Scheduled" },
];

/** Autopilot lives under Creator: one tap to the running loop (or to start one). */
function AutopilotLink() {
  const { workspaceId, appId } = useCurrentApp();
  const r = routes.app(workspaceId, appId);
  const active = useActiveAutopilot(workspaceId, appId);
  const waiting = active?.status === "awaiting_user";
  return (
    <Link
      href={active ? `${r.autopilot}?loop=${encodeURIComponent(active.id)}` : r.autopilot}
      prefetch={false}
      className="group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pl-2.5 pr-1.5 text-footnote font-medium text-ink-2 transition-colors hover:bg-mist hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
    >
      <Rocket className="size-3.5 text-accent" aria-hidden />
      Autopilot
      {active ? (
        <span
          className={cn("size-1.5 rounded-full", waiting ? "bg-warning" : isWorking(active.status) ? "animate-pulse bg-accent" : "bg-ink-3")}
          aria-label={waiting ? "waiting for you" : isWorking(active.status) ? "working" : undefined}
        />
      ) : null}
      <ChevronRight className="size-3.5 text-ink-3 transition-transform group-hover:translate-x-0.5" aria-hidden />
    </Link>
  );
}

/**
 * Creator's sub-tabs: Make (ideas and campaigns, or Autopilot's work), Videos (the app's files) and
 * Scheduled (posts and publishing), plus the way into Autopilot. The control sits centred on
 * tablets and up so it doesn't move between sub-tabs.
 */
export function CreatorTabs({ current, className }: { current: CreatorView; className?: string }) {
  const { workspaceId, appId } = useCurrentApp();
  const r = routes.app(workspaceId, appId);
  const href: Record<CreatorView, string> = { make: r.creator, videos: r.videos, scheduled: r.scheduled };
  return (
    <div className={cn("mb-8 flex items-center justify-between gap-3 md:mb-10 md:grid md:grid-cols-[1fr_auto_1fr]", className)}>
      <span aria-hidden className="hidden md:block" />
      <nav aria-label="Creator">
        <SegmentedControl
          label="Creator"
          size="md"
          value={current}
          items={VIEWS.map((v) => ({ ...v, href: href[v.value] }))}
          renderLink={(p) => (
            <Link href={p.href} className={p.className} aria-current={p["aria-current"]} prefetch={false}>
              {p.children}
            </Link>
          )}
        />
      </nav>
      <div className="flex justify-end">
        <AutopilotLink />
      </div>
    </div>
  );
}

/** A Creator sub-tab page: the shared frame (same width on every sub-tab) with the sub-tabs on top. */
export function CreatorFrame({ current, children }: { current: CreatorView; children: ReactNode }) {
  return (
    <PageContainer width="wide" className="pt-5 md:pt-6">
      <CreatorTabs current={current} />
      {children}
    </PageContainer>
  );
}
