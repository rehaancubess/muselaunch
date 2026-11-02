"use client";
import { Notice, Spinner } from "@muselaunch/ui";
import Link from "next/link";
import { useActiveAutopilot } from "@/components/shell/autopilot-chip";
import { routes } from "@/lib/routes";

/**
 * Autopilot on: research for a new app runs as the first part of its Autopilot run (the same cited
 * Muse Wonder research), so Discover says so instead of waiting for someone to press a button.
 * `stages` narrows when it shows (the simple page shows research progress itself).
 */
export function AutopilotResearchNotice({ workspaceId, appId, stages = ["understand", "research"], className = "mb-8" }: { workspaceId: string; appId: string; stages?: string[]; className?: string }) {
  const active = useActiveAutopilot(workspaceId, appId);
  if (!active || !stages.includes(active.stage) || !["running", "waiting_on_jobs"].includes(active.status)) return null;
  return (
    <Notice tone="info" icon={<Spinner className="size-4" />} className={className} title={active.stage === "understand" ? "Autopilot is learning about your app" : "Autopilot is researching your market"}>
      New findings appear here as they’re found, each linked to its sources.{" "}
      <Link href={routes.app(workspaceId, appId).creator} className="font-medium underline underline-offset-2">
        See the run
      </Link>
    </Notice>
  );
}
