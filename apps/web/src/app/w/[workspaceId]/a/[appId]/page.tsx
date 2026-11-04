import { redirect } from "next/navigation";
import { routes, withQuery } from "@/lib/routes";

/** The app opens on Home (what's ready to review, what's coming up, what needs you). */
export default async function AppRoot({ params, searchParams }: { params: Promise<{ workspaceId: string; appId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId, appId } = await params;
  redirect(withQuery(routes.app(workspaceId, appId).home, await searchParams));
}
