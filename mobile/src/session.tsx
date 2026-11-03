/**
 * The phone's session: its link (device token, kept in secure storage), which API it talks to, who
 * it acts for (GET /v1/me), and which workspace and app are open. A 401 from the API means the
 * phone was removed on the web (or its link expired): the token is dropped and the Link screen
 * says why.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createApi, defaultApiBase, type Api } from "./api/client";
import { getItem, KEYS, setItem } from "./api/storage";
import type { App, MeResponse, Page, Workspace, WorkspaceMember } from "./api/types";

export interface StoredDevice {
  id: string;
  name: string;
}

interface State {
  loaded: boolean;
  token: string | null;
  device: StoredDevice | null;
  apiBase: string;
  workspaceId: string | null;
  appId: string | null;
  /** Why the phone is on the Link screen again (unlinked on the web, expired). */
  notice: string | null;
}

export interface SessionValue {
  loaded: boolean;
  linked: boolean;
  apiBase: string;
  isDefaultApi: boolean;
  api: Api;
  device: StoredDevice | null;
  notice: string | null;
  me: MeResponse | null;
  meLoading: boolean;
  meError: unknown;
  workspace: Workspace | null;
  member: WorkspaceMember | null;
  workspaceId: string | null;
  apps: App[];
  appsLoading: boolean;
  app: App | null;
  appId: string | null;
  signIn: (token: string, device: StoredDevice, opts?: { apiBase?: string }) => Promise<void>;
  signOut: (notice?: string | null) => Promise<void>;
  setApiBase: (base: string | null) => Promise<void>;
  select: (sel: { workspaceId?: string | null; appId?: string | null }) => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [state, setState] = useState<State>({ loaded: false, token: null, device: null, apiBase: defaultApiBase(), workspaceId: null, appId: null, notice: null });

  useEffect(() => {
    void (async () => {
      const [token, device, api, workspaceId, appId] = await Promise.all([getItem(KEYS.token), getItem(KEYS.device), getItem(KEYS.api), getItem(KEYS.workspace), getItem(KEYS.app)]);
      let dev: StoredDevice | null = null;
      try {
        dev = device ? (JSON.parse(device) as StoredDevice) : null;
      } catch {
        dev = null;
      }
      setState({ loaded: true, token, device: dev, apiBase: api || defaultApiBase(), workspaceId, appId, notice: null });
    })();
  }, []);

  const signOut = useCallback(
    async (notice: string | null = null) => {
      await Promise.all([setItem(KEYS.token, null), setItem(KEYS.device, null), setItem(KEYS.workspace, null), setItem(KEYS.app, null)]);
      qc.clear();
      setState((s) => ({ ...s, token: null, device: null, workspaceId: null, appId: null, notice }));
    },
    [qc],
  );
  // A 401 can arrive from many requests at once: drop the link once.
  const unlinking = useRef(false);
  const onUnauthenticated = useCallback(() => {
    if (unlinking.current) return;
    unlinking.current = true;
    void signOut("This phone isn’t linked any more (it was removed on the web, or the link expired). Link it again to carry on.").finally(() => {
      unlinking.current = false;
    });
  }, [signOut]);

  const bare = useMemo(() => createApi({ base: state.apiBase, token: state.token, onUnauthenticated }), [state.apiBase, state.token, onUnauthenticated]);
  const meQ = useQuery({ queryKey: ["me", state.apiBase, state.token], queryFn: () => bare.get<MeResponse>("/v1/me"), enabled: Boolean(state.token), staleTime: 60_000 });
  const me = meQ.data ?? null;
  const ws =
    me?.workspaces.find((w) => w.workspace.id === state.workspaceId) ?? me?.workspaces.find((w) => w.workspace.id === me.user.defaultWorkspaceId) ?? me?.workspaces[0] ?? null;
  const workspaceId = ws?.workspace.id ?? null;
  const api = useMemo(() => createApi({ base: state.apiBase, token: state.token, workspaceId, onUnauthenticated }), [state.apiBase, state.token, workspaceId, onUnauthenticated]);
  const appsQ = useQuery({ queryKey: ["apps", state.apiBase, workspaceId], queryFn: () => api.get<Page<App>>(api.ws("/apps")), enabled: Boolean(state.token && workspaceId), staleTime: 60_000 });
  const apps = useMemo(() => (appsQ.data?.items ?? []).filter((a) => a.status !== "archived"), [appsQ.data]);
  const app = apps.find((a) => a.id === state.appId) ?? apps[0] ?? null;

  const signIn = useCallback(
    async (token: string, device: StoredDevice, opts: { apiBase?: string } = {}) => {
      const apiBase = (opts.apiBase ?? state.apiBase).replace(/\/+$/, "");
      await Promise.all([setItem(KEYS.token, token), setItem(KEYS.device, JSON.stringify(device)), setItem(KEYS.api, apiBase === defaultApiBase() ? null : apiBase), setItem(KEYS.workspace, null), setItem(KEYS.app, null)]);
      qc.clear();
      setState((s) => ({ ...s, token, device, apiBase, workspaceId: null, appId: null, notice: null }));
    },
    [qc, state.apiBase],
  );

  const setApiBase = useCallback(async (base: string | null) => {
    const next = (base?.trim() || defaultApiBase()).replace(/\/+$/, "");
    await setItem(KEYS.api, next === defaultApiBase() ? null : next);
    setState((s) => ({ ...s, apiBase: next }));
  }, []);

  const select = useCallback(async (sel: { workspaceId?: string | null; appId?: string | null }) => {
    if (sel.workspaceId !== undefined) await setItem(KEYS.workspace, sel.workspaceId);
    if (sel.appId !== undefined) await setItem(KEYS.app, sel.appId);
    setState((s) => ({ ...s, ...(sel.workspaceId !== undefined ? { workspaceId: sel.workspaceId } : {}), ...(sel.appId !== undefined ? { appId: sel.appId } : {}) }));
  }, []);

  const value: SessionValue = {
    loaded: state.loaded,
    linked: Boolean(state.token),
    apiBase: state.apiBase,
    isDefaultApi: state.apiBase === defaultApiBase(),
    api,
    device: state.device,
    notice: state.notice,
    me,
    meLoading: meQ.isLoading,
    meError: meQ.error,
    workspace: ws?.workspace ?? null,
    member: ws?.member ?? null,
    workspaceId,
    apps,
    appsLoading: appsQ.isLoading,
    app,
    appId: app?.id ?? null,
    signIn,
    signOut,
    setApiBase,
    select,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

/** The workspace's time zone (scheduled times are shown in it, like on the web). */
export function useTimezone(): string {
  const { workspace } = useSession();
  return workspace?.settings.defaultTimezone || "UTC";
}
