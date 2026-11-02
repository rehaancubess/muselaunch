"use client";
/**
 * "Where do you post?": big tappable platforms (Instagram, YouTube, TikTok, LinkedIn, X) and "I'll
 * post myself", used by the first-run quick setup and Settings › The basics.
 *
 * Honest per platform, from the deployment's provider catalog (GET /connections):
 *  - connected            → posts can go out there once you approve them;
 *  - available            → tapping it starts the existing OAuth connect flow (accounts.manage);
 *  - pending_review / not set up / no permission → one plain line, and you get the video and
 *    caption to post yourself.
 * The choice is saved per app (PUT /apps/:appId/post-to, content.write): Autopilot drafts its posts
 * for it. Nothing here posts; every post still waits for its approval.
 */
import type { App, PostToChannel } from "@muselaunch/contracts";
import { Button, Spinner, cn, useToast } from "@muselaunch/ui";
import { Check, Download, Link2, Unplug } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { useApiQuery, useInvalidate, useQueryClient } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import { platformLine, platformStates, type PlatformState } from "./posting-lines";
import type { ConnectionsResponse } from "./types";

export { platformLine, platformStates, POST_PLATFORMS, wherePostSummary, type PlatformState } from "./posting-lines";

/** Simple monochrome marks so each platform is recognisable at a glance (not the official logos). */
export function PlatformGlyph({ channel, className }: { channel: PostToChannel | "manual"; className?: string }) {
  const common = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true, className: cn("size-6", className) };
  switch (channel) {
    case "instagram":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="5" />
          <circle cx="12" cy="12" r="3.8" />
          <circle cx="17.2" cy="6.8" r="0.6" fill="currentColor" />
        </svg>
      );
    case "youtube":
      return (
        <svg {...common}>
          <rect x="2.5" y="5.5" width="19" height="13" rx="4" />
          <path d="M10.2 9.4v5.2l4.4-2.6z" fill="currentColor" />
        </svg>
      );
    case "tiktok":
      return (
        <svg {...common}>
          <path d="M13.5 3.5v11.2a3.3 3.3 0 1 1-3.3-3.3" />
          <path d="M13.5 3.5c.4 2.4 2.2 4.1 4.8 4.3" />
        </svg>
      );
    case "linkedin":
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="3" />
          <path d="M8 10.5v6M8 7.6v.01M11.5 16.5v-6M11.5 13.2c0-1.6 1-2.7 2.4-2.7s2.1 1 2.1 2.6v3.4" />
        </svg>
      );
    case "x":
      return (
        <svg {...common}>
          <path d="M4.5 4.5h4l11 15h-4z" />
          <path d="M19.2 4.5l-6.1 6.9M4.8 19.5l6.1-6.9" />
        </svg>
      );
    case "manual":
      return <Download className={cn("size-6", className)} aria-hidden />;
  }
}

export function useConnections(workspaceId: string) {
  return useApiQuery<ConnectionsResponse>(wsPath(workspaceId, "/connections"), { staleTime: 30_000 });
}

/**
 * Coming back from a provider's consent screen (security review N1): the callback only parked a
 * PENDING connection; the signed-in user finishes it here, and the completion token is stripped
 * from the URL at once. Render it once per page that a connect flow returns to.
 */
export function useConnectionReturn(onConnected?: (account: { provider: string; displayName: string }) => void) {
  const { workspaceId } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const sp = new URLSearchParams(window.location.search);
    if (!sp.has("connections") && !sp.has("finish")) return;
    const finish = sp.get("finish");
    const status = sp.get("status");
    const message = sp.get("message");
    for (const k of ["connections", "finish", "status", "provider", "message", "account"]) sp.delete(k);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${sp.toString() ? `?${sp}` : ""}`);
    if (finish) {
      api
        .post<{ account: { provider: string; displayName: string } }>(wsPath(workspaceId, "/connections/finish"), { token: finish })
        .then((r) => {
          toast.success("Account connected", r.account.displayName);
          onConnected?.(r.account);
          void invalidate(wsPath(workspaceId, "/connections"));
        })
        .catch((e) => toast.error("The account wasn’t connected", errorMessage(e)));
    } else if (status === "cancelled" || status === "error") {
      toast.error("Connection didn’t complete", message ?? undefined);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

/** Save "Where do you post?" for an app; the workspace's app list is updated in place. */
export function useSavePostTo(appId: string) {
  const { workspaceId } = useWorkspace();
  const qc = useQueryClient();
  return async (next: { channels: PostToChannel[]; manual: boolean }) => {
    const r = await api.put<{ app: App }>(wsPath(workspaceId, `/apps/${appId}/post-to`), next);
    qc.setQueryData<Page<App>>([wsPath(workspaceId, "/apps")], (old) => (old ? { ...old, items: old.items.map((a) => (a.id === r.app.id ? r.app : a)) } : old));
    return r.app;
  };
}

function Tile({ on, disabled, busy, onClick, glyph, label, hint, hintTone = "muted" }: { on: boolean; disabled?: boolean; busy?: boolean; onClick: () => void; glyph: ReactNode; label: string; hint?: string; hintTone?: "muted" | "good" }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // Phones: the mark above the name (two tiles a row stay roomy); wider screens: side by side.
        "relative flex min-h-[72px] w-full flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors duration-150 sm:flex-row sm:items-center sm:gap-3 sm:px-3.5",
        "focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60",
        on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong hover:bg-mist/40",
      )}
    >
      <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-full", on ? "bg-surface text-accent-ink" : "bg-mist text-ink")}>{busy ? <Spinner size={16} /> : glyph}</span>
      <span className="min-w-0 flex-1 pr-5 sm:pr-0">
        <span className={cn("block text-body-sm font-medium", on ? "text-accent-ink" : "text-ink")}>{label}</span>
        {hint ? <span className={cn("block text-caption", hintTone === "good" ? "text-success" : "text-ink-3")}>{hint}</span> : null}
      </span>
      {on ? <Check className="absolute right-3 top-3 size-4 shrink-0 text-accent sm:static" aria-hidden /> : null}
    </button>
  );
}

const HINT: Record<PlatformState["state"], string> = { connected: "Connected", available: "Tap to connect", pending_review: "In review", not_configured: "You post it" };

/**
 * The platforms as big tiles plus "I'll post myself". `back`: the page the OAuth flow returns to
 * ("autopilot" = the progress screen with the quick setup, "settings" = Settings › The basics).
 * `beforeConnect` runs right before the browser leaves for the provider (e.g. remember the step).
 */
export function WherePostPicker({ app, back, beforeConnect, narrow, className }: { app: App; back: "autopilot" | "settings"; beforeConnect?: () => void; /** Two tiles a row (a side sheet). */ narrow?: boolean; className?: string }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const q = useConnections(workspaceId);
  const save = useSavePostTo(app.id);
  const [choice, setChoice] = useState<{ channels: PostToChannel[]; manual: boolean }>({ channels: app.postTo?.channels ?? [], manual: app.postTo?.manual ?? false });
  const [busy, setBusy] = useState<string | null>(null);
  const canChange = can("content.write");
  const canConnect = can("accounts.manage");
  const states = platformStates(q.data, app.id);

  // Saves go out one after another, so quick taps can't land out of order on the server.
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const persist = async (next: typeof choice) => {
    const prev = choice;
    setChoice(next);
    const run = queue.current.then(() => save(next));
    queue.current = run.catch(() => undefined);
    try {
      await run;
      return true;
    } catch (e) {
      setChoice(prev);
      toast.error("Couldn’t save where you post", errorMessage(e));
      return false;
    }
  };
  const connect = async (s: PlatformState) => {
    if (!s.provider) return;
    setBusy(s.channel);
    try {
      const r = await api.post<{ authorizeUrl: string }>(wsPath(workspaceId, `/connections/${s.provider.provider}/start`), { appId: app.id, back });
      beforeConnect?.();
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      toast.error(`Couldn’t open ${s.label}`, errorMessage(e));
      setBusy(null);
    }
  };
  const tap = async (s: PlatformState) => {
    const on = choice.channels.includes(s.channel);
    const next = { channels: on ? choice.channels.filter((c) => c !== s.channel) : [...choice.channels, s.channel], manual: false };
    if (!(await persist(next))) return;
    // Available here and not connected yet: tapping it starts the connect flow (you can cancel there).
    if (!on && s.state === "available" && canConnect) await connect(s);
  };
  const chosen = states.filter((s) => choice.channels.includes(s.channel));
  return (
    <div className={cn("space-y-4", className)}>
      <div role="group" aria-label="Where do you post?" className={cn("grid grid-cols-2 gap-2.5", !narrow && "sm:grid-cols-3")}>
        {states.map((s) => (
          <Tile
            key={s.channel}
            on={choice.channels.includes(s.channel)}
            disabled={!canChange || busy !== null || q.isLoading}
            busy={busy === s.channel}
            onClick={() => void tap(s)}
            glyph={<PlatformGlyph channel={s.channel} />}
            label={s.label}
            hint={s.state === "available" ? (choice.channels.includes(s.channel) ? "Not connected yet" : canConnect ? "Tap to connect" : "Owner connects it") : HINT[s.state]}
            hintTone={s.state === "connected" ? "good" : "muted"}
          />
        ))}
        <Tile
          on={choice.manual}
          disabled={!canChange || busy !== null}
          onClick={() => void persist(choice.manual ? { channels: [], manual: false } : { channels: [], manual: true })}
          glyph={<PlatformGlyph channel="manual" />}
          label="I’ll post myself"
          hint="Video + caption"
        />
      </div>
      {choice.manual ? (
        <p className="text-footnote text-ink-2 text-pretty">You’ll get each video and its caption, ready to post wherever you like.</p>
      ) : chosen.length ? (
        <ul className="space-y-2">
          {chosen.map((s) => (
            <li key={s.channel} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-footnote text-ink-2">
              <span className="min-w-0 flex-1 basis-60 text-pretty">{platformLine(s, canConnect)}</span>
              {s.state === "available" && canConnect ? (
                <Button size="sm" variant="outline" className="h-11 px-4 sm:h-8 sm:px-3" icon={<Link2 aria-hidden />} loading={busy === s.channel} disabled={busy !== null} onClick={() => void connect(s)}>
                  Connect {s.label}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {!canChange ? <p className="text-footnote text-ink-3">Only editors, admins and owners can change this.</p> : null}
      {q.error ? <p className="text-footnote text-warning">Couldn’t check which accounts are connected: {errorMessage(q.error)}</p> : null}
    </div>
  );
}

/** Connected posting accounts with Disconnect (accounts.manage), for Settings. */
export function ConnectedPostingAccounts({ appId }: { appId: string }) {
  const { workspaceId, can } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const q = useConnections(workspaceId);
  const [busy, setBusy] = useState<string | null>(null);
  const connected = platformStates(q.data, appId).filter((s) => s.account);
  if (!connected.length) return null;
  const disconnect = async (id: string) => {
    setBusy(id);
    try {
      const r = await api.del<{ note?: string }>(wsPath(workspaceId, `/connections/${id}`));
      toast.toast({ title: "Disconnected", description: r.note, tone: "neutral" });
      await invalidate(wsPath(workspaceId, "/connections"));
    } catch (e) {
      toast.error("Couldn’t disconnect", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-2">
      <p className="text-footnote font-medium text-ink-2">Connected accounts</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {connected.map((s) => (
          <li key={s.account!.id} className="flex min-h-14 items-center gap-3 px-3.5 py-2">
            <PlatformGlyph channel={s.channel} className="size-5 text-ink-2" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body-sm font-medium text-ink">{s.account!.displayName}</span>
              <span className="block text-caption text-ink-3">{s.label}</span>
            </span>
            {can("accounts.manage") ? (
              <Button size="sm" variant="ghost" className="h-11 sm:h-8" icon={<Unplug aria-hidden />} loading={busy === s.account!.id} onClick={() => void disconnect(s.account!.id)}>
                Disconnect
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
