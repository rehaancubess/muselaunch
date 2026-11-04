import { redirect } from "next/navigation";
import { routes, withQuery } from "@/lib/routes";

/** The Calendar moved into Creator → Scheduled. Old links (notifications, OAuth returns with `?connections=1`) keep working. */
export default async function CalendarRedirect({ params, searchParams }: { params: Promise<{ workspaceId: string; appId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId, appId } = await params;
  redirect(withQuery(routes.app(workspaceId, appId).scheduled, await searchParams));
}
