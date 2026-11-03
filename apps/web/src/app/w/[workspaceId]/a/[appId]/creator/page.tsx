import { redirect } from "next/navigation";
import { routes, withQuery } from "@/lib/routes";

/**
 * Creator → Today became Home. Old links (notifications, bookmarks) keep working; Creator's deep pages
 * (make, videos, scheduled, studio, campaigns, new) stay where they are, under the Create tab.
 */
export default async function CreatorRedirect({ params, searchParams }: { params: Promise<{ workspaceId: string; appId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId, appId } = await params;
  redirect(withQuery(routes.app(workspaceId, appId).home, await searchParams));
}
