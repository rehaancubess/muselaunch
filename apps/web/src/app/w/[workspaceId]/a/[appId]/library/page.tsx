import { redirect } from "next/navigation";
import { routes, withQuery } from "@/lib/routes";

/** The Library moved into Creator → Videos. Old links (notifications, bookmarks) keep working, `?asset=` too. */
export default async function LibraryRedirect({ params, searchParams }: { params: Promise<{ workspaceId: string; appId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId, appId } = await params;
  redirect(withQuery(routes.app(workspaceId, appId).videos, await searchParams));
}
