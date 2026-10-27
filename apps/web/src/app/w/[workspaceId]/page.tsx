"use client";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { FullPageLoader } from "@/components/require-auth";
import { readLastApp } from "@/components/shell/app-shell";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

/** Workspace root: open the last-used app's Creator, or add the first app. */
export default function WorkspaceHome() {
  const router = useRouter();
  const { workspaceId, apps, appsLoading } = useWorkspace();
  useEffect(() => {
    if (appsLoading) return;
    if (!apps.length) return router.replace(routes.newApp(workspaceId));
    const last = readLastApp(workspaceId);
    const target = apps.find((a) => a.id === last) ?? apps[0]!;
    router.replace(routes.app(workspaceId, target.id).creator);
  }, [apps, appsLoading, router, workspaceId]);
  return <FullPageLoader />;
}
