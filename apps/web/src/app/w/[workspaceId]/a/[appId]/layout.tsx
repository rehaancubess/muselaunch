"use client";
import { Button, EmptyState, Skeleton } from "@muselaunch/ui";
import { AppWindow } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { PageContainer } from "@/components/page-container";
import { routes } from "@/lib/routes";
import { useRouteIds, useWorkspace } from "@/lib/workspace";

/** Ensures the app in the URL exists in this workspace before rendering a tab. */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { appId } = useRouteIds();
  const { app, appsLoading, workspaceId } = useWorkspace();
  if (appsLoading) {
    return (
      <PageContainer>
        <Skeleton className="mb-3 h-9 w-64" />
        <Skeleton className="h-5 w-96 max-w-full" />
      </PageContainer>
    );
  }
  if (!app) {
    return (
      <PageContainer width="narrow">
        <EmptyState
          size="lg"
          icon={<AppWindow aria-hidden />}
          title="App not found"
          description={`There’s no app with id ${appId} in this workspace. It may have been archived.`}
          action={
            <Button asChild>
              <Link href={routes.workspace(workspaceId)}>Open my apps</Link>
            </Button>
          }
        />
      </PageContainer>
    );
  }
  return <>{children}</>;
}
