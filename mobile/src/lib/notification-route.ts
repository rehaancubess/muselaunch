import { parseQuery } from "./link-code";

/**
 * Where a tapped notification goes: the app path and the workspace/app it's about. The server sends
 * `data.url` as an app path ("/results?w=…&a=…"); a full deep link (`muselaunch:///results?…`) works too.
 * Only Home and Results are destinations: anything else opens Home.
 */
export function routeForNotification(data: unknown): { path: "/" | "/results"; workspaceId?: string; appId?: string } | null {
  const d = (data ?? {}) as { url?: unknown; workspaceId?: unknown; appId?: unknown };
  if (typeof d.url !== "string") return null;
  const url = d.url.replace(/^muselaunch:\/\/\/?/i, "/");
  const [path = "/", query = ""] = url.split("?");
  const q = parseQuery(query);
  const screen = path.replace(/\/+$/, "") === "/results" ? "/results" : "/";
  const workspaceId = q.w ?? (typeof d.workspaceId === "string" ? d.workspaceId : undefined);
  const appId = q.a ?? (typeof d.appId === "string" ? d.appId : undefined);
  return { path: screen, ...(workspaceId ? { workspaceId } : {}), ...(appId ? { appId } : {}) };
}
