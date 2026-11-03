import { redirect } from "next/navigation";
import { routes, withQuery } from "@/lib/routes";

/**
 * "What Muse found" moved into Create ("Use a suggested idea"). Old links (notifications, Needs-you
 * review paths, bookmarks) keep working; Discover → See everything (./all) stays, under the Create tab.
 */
export default async function DiscoverRedirect({ params, searchParams }: { params: Promise<{ workspaceId: string; appId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId, appId } = await params;
  redirect(withQuery(routes.app(workspaceId, appId).create(), { ...(await searchParams), kind: "idea" }));
}
