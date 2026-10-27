"use client";
import type { App } from "@muselaunch/contracts";
import { Avatar, cn } from "@muselaunch/ui";
import { wsPath } from "@/lib/api";
import type { SignedUrl } from "@/lib/api-types";
import { useApiQuery } from "@/lib/query";

/** Signed, short-lived URL for a workspace asset (cached ~45 min; URLs last 60). */
export function useAssetUrl(workspaceId: string | undefined, assetId: string | undefined | null, opts: { download?: boolean } = {}) {
  return useApiQuery<SignedUrl>(workspaceId && assetId ? wsPath(workspaceId, `/assets/${assetId}/url`) : null, {
    query: opts.download ? { download: 1 } : undefined,
    staleTime: 45 * 60_000,
    gcTime: 50 * 60_000,
    refetchOnWindowFocus: false,
  });
}

/** App icon from its imported icon asset, or a quiet initials squircle. */
export function AppIcon({ app, workspaceId, size = 28, className }: { app: Pick<App, "name" | "iconAssetId"> | null | undefined; workspaceId: string; size?: number; className?: string }) {
  const url = useAssetUrl(workspaceId, app?.iconAssetId);
  if (url.data?.url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={url.data.url} alt="" width={size} height={size} className={cn("shrink-0 rounded-[24%] object-cover shadow-[0_0_0_0.5px_rgb(0_0_0/0.12)]", className)} style={{ width: size, height: size }} />
    );
  }
  return <Avatar name={app?.name ?? "App"} size={size} shape="squircle" className={className} />;
}
