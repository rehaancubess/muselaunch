"use client";
/**
 * Notifications in the browser (lib/web-push.ts), as people see them.
 *
 * - <NotifyMe>: "Notify me when it’s ready" (first-run screen, Create page). Turns notifications on for
 *   this browser; once on: "Notifications are on. You’ll get them even with MuseLaunch closed." When
 *   the server has them off (or the browser can't), it shows `fallback` (the first run's in-tab notice).
 * - <BrowserNotificationSettings>: Settings → Notifications: this browser on/off, every browser that
 *   gets them (Remove), Send a test, and where iPhone notifications come from (the phone app).
 */
import type { WebPushBrowserView } from "@muselaunch/contracts";
import { Badge, Button, Notice, Skeleton, Switch, useToast } from "@muselaunch/ui";
import { Bell, BellOff, BellRing, Laptop, Send, Smartphone } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, errorMessage, request } from "@/lib/api";
import { useAuth } from "@/lib/auth/auth-provider";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { isAppleMobile, thisBrowserId, useWebPush, WEB_PUSH_PATH, type WebPushState } from "@/lib/web-push";

/** This browser's notification state for the person signed in here. */
export function useBrowserNotifications() {
  const { user } = useAuth();
  return useWebPush(user?.uid);
}

export const ON_LINE = "Notifications are on. You’ll get them even with MuseLaunch closed.";
const APPLE_LINE = "On iPhone and iPad, notifications come through the MuseLaunch phone app.";
const DENIED_LINE = "Notifications are blocked for MuseLaunch in this browser. Allow them in the browser’s site settings to get them here.";

export function NotifyMe({ label = "Notify me when it’s ready", fallback, className }: { label?: string; fallback?: ReactNode; className?: string }) {
  const toast = useToast();
  const { state, busy, enable } = useBrowserNotifications();
  if (state === null) return null;
  if (state === "on") {
    return (
      <p className={className ?? "inline-flex items-start gap-1.5 text-footnote font-medium text-ink text-pretty"}>
        <BellRing className="mt-px size-4 shrink-0 text-accent" aria-hidden />
        {ON_LINE}
      </p>
    );
  }
  if (state === "denied") return <p className="text-footnote text-ink-2 text-pretty">{DENIED_LINE}</p>;
  if (state === "unsupported" && isAppleMobile()) {
    return (
      <p className="inline-flex items-start gap-1.5 text-footnote text-ink-2 text-pretty">
        <Smartphone className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        {APPLE_LINE}
      </p>
    );
  }
  if (state === "server-off" || state === "unsupported") return <>{fallback ?? null}</>;
  return (
    <Button
      variant="secondary"
      icon={<Bell className="size-4" aria-hidden />}
      loading={busy}
      onClick={async () => {
        try {
          const s = await enable();
          if (s === "denied") toast.error("Notifications are blocked", "Allow them for this site in your browser’s settings, then try again.");
        } catch (e) {
          toast.error("Couldn’t turn notifications on", errorMessage(e));
        }
      }}
    >
      {label}
    </Button>
  );
}

function stateLine(state: WebPushState | null): string {
  switch (state) {
    case null:
      return "Checking this browser…";
    case "on":
      return "On. Notes arrive here even with MuseLaunch closed.";
    case "off":
      return "Off. Turn it on to get notes here even with MuseLaunch closed.";
    case "denied":
      return "Blocked by this browser. Allow notifications for this site in the browser’s settings, then turn this on.";
    case "server-off":
      return "Not available yet: notifications in the browser aren’t set up on this server.";
    case "unsupported":
      return isAppleMobile()
        ? "Safari on iPhone and iPad only allows notifications for sites added to the Home Screen. Use the MuseLaunch phone app instead."
        : "This browser can’t show notifications from websites.";
  }
}

function ago(iso?: string): string | null {
  if (!iso) return null;
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });

export function BrowserNotificationSettings() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const { state, busy, enable, disable } = useBrowserNotifications();
  const list = useApiQuery<{ items: WebPushBrowserView[]; enabled: boolean }>(WEB_PUSH_PATH, { retry: false });
  const items = list.data?.items ?? [];
  const [mine, setMine] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  useEffect(() => {
    void thisBrowserId().then(setMine);
  }, [state]);

  const toggle = async (on: boolean) => {
    try {
      const s = on ? await enable() : await disable();
      if (on && s === "on") toast.success("Notifications are on", "You’ll get them in this browser even with MuseLaunch closed.");
      else if (on && s === "denied") toast.error("Notifications are blocked", "Allow them for this site in your browser’s settings, then try again.");
      else if (!on) toast.success("Notifications are off in this browser");
    } catch (e) {
      toast.error("Couldn’t change notifications", errorMessage(e));
    } finally {
      await invalidate(WEB_PUSH_PATH);
    }
  };

  const test = async () => {
    setWorking("test");
    try {
      const r = await api.post<{ result: { browsers: number; sent: number; failed: number; removed: number } }>(`${WEB_PUSH_PATH}/test`);
      if (r.result.sent) toast.success("Test sent", r.result.sent === 1 ? "It should show up in a moment." : `Sent to ${r.result.sent} browsers. It should show up in a moment.`);
      else if (r.result.removed) {
        toast.error("The test didn’t go out", "This browser’s notifications had expired, so MuseLaunch removed them. Turn them on again here.");
        if (state === "on") await disable().catch(() => undefined);
      } else toast.error("The test didn’t go out", "MuseLaunch couldn’t hand it to the browser’s notification service. Try again in a moment; if it keeps failing, turn notifications off and on again here.");
    } catch (e) {
      toast.error("Couldn’t send a test", errorMessage(e));
    } finally {
      setWorking(null);
      await invalidate(WEB_PUSH_PATH);
    }
  };

  const remove = async (b: WebPushBrowserView) => {
    if (b.id === mine) return toggle(false);
    if (!window.confirm(`Stop notifications on ${b.label}?`)) return;
    setWorking(b.id);
    try {
      await request("DELETE", WEB_PUSH_PATH, { body: { id: b.id } });
      toast.success("Browser removed", `${b.label} won’t get notifications any more.`);
    } catch (e) {
      toast.error("Couldn’t remove it", errorMessage(e));
    } finally {
      setWorking(null);
      await invalidate(WEB_PUSH_PATH);
    }
  };

  const canToggle = state === "on" || state === "off";
  return (
    <div className="space-y-4 rounded-xl bg-surface p-5 shadow-raised sm:p-6">
      <div className="space-y-1">
        <p className="text-body font-medium text-ink">Notifications in your browser</p>
        <p className="text-footnote text-ink-2 text-pretty">A note on your computer or Android phone when your first videos are ready, when a video is finished or when Muse needs you, even with MuseLaunch closed.</p>
      </div>

      <label className="flex items-start justify-between gap-4 rounded-2xl bg-mist/70 p-4" htmlFor="wp-this-browser">
        <span className="flex min-w-0 items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">{state === "on" ? <BellRing className="size-4" aria-hidden /> : <BellOff className="size-4" aria-hidden />}</span>
          <span className="min-w-0 space-y-0.5">
            <span className="block text-body-sm font-medium text-ink">This browser</span>
            <span className="block text-footnote text-ink-2 text-pretty" aria-live="polite">
              {stateLine(state)}
            </span>
          </span>
        </span>
        <Switch id="wp-this-browser" label="Notifications in this browser" checked={state === "on"} disabled={busy || !canToggle} onCheckedChange={(v) => void toggle(v)} />
      </label>

      {items.length ? (
        <Button variant="outline" size="sm" icon={<Send className="size-3.5" aria-hidden />} loading={working === "test"} onClick={() => void test()}>
          Send a test
        </Button>
      ) : null}

      <div className="space-y-2 border-t border-line pt-4">
        <p className="text-footnote font-medium text-ink-2">Browsers getting notifications</p>
        {list.isLoading ? (
          <Skeleton className="h-14 w-full" rounded="lg" />
        ) : list.error ? (
          <Notice tone="warning">Couldn’t load your browsers: {errorMessage(list.error)}</Notice>
        ) : items.length ? (
          <ul className="divide-y divide-line">
            {items.map((b) => (
              <li key={b.id} className="flex items-center gap-3 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  {/Android/.test(b.label) ? <Smartphone className="size-4" aria-hidden /> : <Laptop className="size-4" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-body-sm font-medium text-ink">{b.label}</span>
                    {b.id === mine ? <Badge tone="accent">This browser</Badge> : null}
                  </span>
                  <span className="block text-caption text-ink-2">
                    On since {day(b.createdAt)}
                    {b.lastSentAt ? ` · last note ${ago(b.lastSentAt)}` : ""}
                  </span>
                </span>
                <Button variant="ghost" size="sm" loading={working === b.id} onClick={() => void remove(b)} aria-label={`Remove ${b.label}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-ink-2">No browsers yet.</p>
        )}
      </div>
      <p className="text-caption text-ink-3 text-pretty">
        iPhone notifications come through the MuseLaunch phone app (Phone app, above). The browser has to be running for a note to show; one sent while it’s closed waits up to a day. Signing out stops them in that browser.
      </p>
    </div>
  );
}
