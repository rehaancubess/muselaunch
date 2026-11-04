import { redirect } from "next/navigation";
import { routes, withQuery } from "@/lib/routes";

/** "How it's going" became Results. Old links keep working; Insights → Details (./details) stays, under the Results tab. */
export default async function InsightsRedirect({ params, searchParams }: { params: Promise<{ workspaceId: string; appId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { workspaceId, appId } = await params;
  redirect(withQuery(routes.app(workspaceId, appId).results, await searchParams));
}
