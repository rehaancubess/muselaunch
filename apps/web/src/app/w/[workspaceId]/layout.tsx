"use client";
import { Button, ErrorState } from "@muselaunch/ui";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { use, type ReactNode } from "react";
import { FullPageLoader, RequireAuth } from "@/components/require-auth";
import { AppShell } from "@/components/shell/app-shell";
import { LogoMark } from "@/components/logo";
import type { PrimaryTab } from "@/lib/routes";
import { WorkspaceProvider, useWorkspace } from "@/lib/workspace";

function shellStateFor(pathname: string): { tab: PrimaryTab | null; section?: string; fullBleed: boolean } {
  const seg = pathname.split("/").filter(Boolean); // w, wid, a, appId, section, ...
  if (seg[2] === "a") {
    const s = seg[4] ?? "creator";
    const tab = s === "discover" || s === "creator" || s === "insights" ? s : null;
    return { tab, section: tab ? undefined : s, fullBleed: s === "creator" && seg[5] === "studio" };
  }
  if (seg[2] === "settings") return { tab: null, section: seg[3] ?? "settings", fullBleed: false };
  return { tab: null, section: seg[2], fullBleed: false };
}

function Gate({ children }: { children: ReactNode }) {
  const ws = useWorkspace();
  const pathname = usePathname() ?? "";
  if (ws.loading) return <FullPageLoader />;
  if (ws.error || !ws.workspace) {
    const notFound = ws.error?.status === 404;
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center px-6">
        <LogoMark size={32} className="mb-6" />
        <ErrorState
          title={notFound ? "This workspace isn’t available" : "We couldn’t open this workspace"}
          message={notFound ? "It doesn’t exist, or you’re not a member. Ask an owner for an invite." : ws.error?.userMessage}
          onRetry={notFound ? undefined : ws.refetch}
          reference={ws.error?.requestId}
        />
        <Button variant="secondary" asChild>
          <Link href="/onboarding">Go to my workspaces</Link>
        </Button>
      </div>
    );
  }
  const st = shellStateFor(pathname);
  return (
    <AppShell tab={st.tab} section={st.section} fullBleed={st.fullBleed}>
      {children}
    </AppShell>
  );
}

export default function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = use(params);
  return (
    <RequireAuth>
      <WorkspaceProvider workspaceId={workspaceId}>
        <Gate>{children}</Gate>
      </WorkspaceProvider>
    </RequireAuth>
  );
}
