"use client";
import type { App } from "@muselaunch/contracts";
import { Avatar, Badge, Menu, MenuContent, MenuItem, MenuLabel, MenuLink, MenuSeparator, MenuTrigger, Tooltip, cn } from "@muselaunch/ui";
import { Activity, ChartColumn, Check, ChevronDown, CreditCard, House, Info, LogOut, Plus, Settings, Sparkles, WandSparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AppIcon } from "@/components/app-icon";
import { LogoMark } from "@/components/logo";
import { useNeedsYou } from "@/features/autopilot/needs-you";
import { useAuth } from "@/lib/auth/auth-provider";
import { routes, type PrimaryTab } from "@/lib/routes";
import { useMe, useWorkspace } from "@/lib/workspace";
import { CommandPalette } from "./command-palette";
import { ActivitySheet, JobsTray } from "./jobs-tray";

/** Shell sections that belong to the one Settings page. */
const SETTINGS_SECTIONS = new Set(["settings", "integrations", "team", "credits"]);

const LAST_APP_KEY = (wid: string) => `ml.lastApp.${wid}`;

export function rememberLastApp(wid: string, appId: string) {
  try {
    window.localStorage.setItem(LAST_APP_KEY(wid), appId);
  } catch {
    /* ignore */
  }
}

export function readLastApp(wid: string): string | null {
  try {
    return window.localStorage.getItem(LAST_APP_KEY(wid));
  } catch {
    return null;
  }
}

/**
 * App + workspace switcher (left of the top bar): your apps (a dot where something waits on you),
 * Add an app, About your app, Settings, and other workspaces.
 */
function AppSwitcher({ app, section }: { app: App | null; section?: string }) {
  const router = useRouter();
  const { workspaceId, workspace, apps } = useWorkspace();
  const me = useMe();
  const needs = useNeedsYou(workspaceId);
  const waiting = new Set((needs.data?.items ?? []).map((i) => i.appId).filter(Boolean));
  const r = app ? routes.app(workspaceId, app.id) : null;
  const otherWorkspaces = me.data?.workspaces.filter((w) => w.workspace.id !== workspaceId) ?? [];
  const go = (h: string) => router.push(h);

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="group flex h-10 min-w-0 items-center gap-2 rounded-full pl-1 pr-2.5 transition-colors hover:bg-mist focus-visible:outline-none focus-visible:shadow-focus data-[state=open]:bg-mist"
          aria-label={`${app?.name ?? workspace?.name ?? "Workspace"}: switch app, About your app and Settings`}
        >
          {app ? <AppIcon app={app} workspaceId={workspaceId} size={28} /> : <LogoMark size={28} />}
          <span className="min-w-0 max-w-[13ch] truncate text-body-sm font-semibold text-ink sm:max-w-[22ch]">{app?.name ?? workspace?.name ?? "Workspace"}</span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent className="w-72">
        {apps.length ? <MenuLabel>Apps in {workspace?.name ?? "this workspace"}</MenuLabel> : null}
        {apps.map((a) => (
          <MenuLink
            key={a.id}
            href={routes.app(workspaceId, a.id).home}
            icon={<AppIcon app={a} workspaceId={workspaceId} size={18} />}
            trailing={
              a.id === app?.id ? (
                <Check className="size-4 text-accent" aria-label="Current app" />
              ) : waiting.has(a.id) ? (
                <span className="size-2 rounded-full bg-accent" role="img" aria-label="Something is waiting for you" />
              ) : null
            }
            onNavigate={go}
          >
            {a.name}
          </MenuLink>
        ))}
        <MenuLink href={routes.newApp(workspaceId)} icon={<Plus />} onNavigate={go}>
          Add an app
        </MenuLink>
        <MenuSeparator />
        {r ? (
          <MenuLink
            href={r.about}
            icon={<Info />}
            active={section === "brand"}
            trailing={app?.dnaStatus === "needs_review" ? <Badge tone="warning">Check</Badge> : null}
            onNavigate={go}
          >
            About your app
          </MenuLink>
        ) : null}
        <MenuLink href={routes.settings.workspace(workspaceId)} icon={<Settings />} active={SETTINGS_SECTIONS.has(section ?? "")} onNavigate={go}>
          Settings
        </MenuLink>
        <MenuSeparator />
        {otherWorkspaces.length ? <MenuLabel>Other workspaces</MenuLabel> : null}
        {otherWorkspaces.map((w) => (
          <MenuLink key={w.workspace.id} href={routes.workspace(w.workspace.id)} icon={<Avatar name={w.workspace.name} size={18} shape="squircle" />} onNavigate={go}>
            {w.workspace.name}
          </MenuLink>
        ))}
        <MenuLink href={`${routes.onboarding()}?new=1`} icon={<Plus />} onNavigate={go}>
          New workspace
        </MenuLink>
      </MenuContent>
    </Menu>
  );
}

function AccountMenu({ onAsk }: { onAsk: () => void }) {
  const { user, signOut, mode } = useAuth();
  const router = useRouter();
  const { credits, workspaceId } = useWorkspace();
  const [activity, setActivity] = useState(false);
  return (
    <>
      <Menu>
        <MenuTrigger asChild>
          <button type="button" aria-label="Account" className="flex size-10 items-center justify-center rounded-full focus-visible:outline-none focus-visible:shadow-focus">
            <Avatar src={user?.photoUrl} name={user?.name ?? user?.email} size={32} />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="w-64">
          <div className="px-2.5 pb-2 pt-1.5">
            <p className="truncate text-body-sm font-medium">{user?.name ?? user?.email}</p>
            {user?.name ? <p className="truncate text-footnote text-ink-2">{user.email}</p> : null}
            {mode === "dev" ? <p className="mt-1 text-caption text-warning">Local dev sign-in</p> : null}
          </div>
          <MenuSeparator />
          <MenuItem icon={<WandSparkles />} trailing={<span className="text-caption text-ink-3">⌘K</span>} onSelect={onAsk}>
            Ask Muse
          </MenuItem>
          <MenuLink href={routes.settings.credits(workspaceId)} icon={<CreditCard />} trailing={credits ? <span className="tabular">{credits.available.toLocaleString()}</span> : null} onNavigate={(h) => router.push(h)}>
            Credits
          </MenuLink>
          <MenuItem icon={<Activity />} onSelect={() => setActivity(true)}>
            Activity
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<LogOut />}
            onSelect={() => {
              void signOut().then(() => router.replace("/"));
            }}
          >
            Sign out
          </MenuItem>
        </MenuContent>
      </Menu>
      <ActivitySheet workspaceId={workspaceId} open={activity} onOpenChange={setActivity} />
    </>
  );
}

const TABS: { value: PrimaryTab; label: string; icon: ReactNode }[] = [
  { value: "home", label: "Home", icon: <House aria-hidden /> },
  { value: "create", label: "Create", icon: <Sparkles aria-hidden /> },
  { value: "results", label: "Results", icon: <ChartColumn aria-hidden /> },
];

function tabHref(wid: string, appId: string | null, t: PrimaryTab): string | undefined {
  if (!appId) return undefined;
  const r = routes.app(wid, appId);
  return t === "home" ? r.home : t === "create" ? r.create() : r.results;
}

/** "2" on Home (what waits on the person in this app); "99+" past that. */
function CountBadge({ count, className }: { count: number; className?: string }) {
  if (!count) return null;
  return (
    <span aria-hidden className={cn("flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[11px] font-semibold leading-none tabular text-white", className)}>
      {count > 99 ? "99+" : count}
    </span>
  );
}

const tabLabel = (label: string, count: number) => (count ? `${label}, ${count} waiting for you` : label);

const ICON_BTN =
  "inline-flex size-10 items-center justify-center rounded-full text-ink-2 transition-colors hover:bg-mist hover:text-ink focus-visible:outline-none focus-visible:shadow-focus [&_svg]:size-[19px]";

/**
 * The app frame (Create. Review. Grow.): a calm translucent top bar with the app switcher on the
 * left, EXACTLY three tabs in the middle (Home · Create · Results; the selected one a soft violet
 * pill, Home with a count when something waits on you), and on the right Ask Muse (⌘K, kept small),
 * the jobs icon (only while something runs), Settings and the account menu. On phones the tabs move
 * to a bottom tab bar. Everything that waits on you is on Home; /needs-you still works for old links.
 */
export function AppShell({ children, tab, section, fullBleed }: { children: ReactNode; tab?: PrimaryTab | null; section?: string; fullBleed?: boolean }) {
  const { workspaceId, app, apps } = useWorkspace();
  const [cmdOpen, setCmdOpen] = useState(false);
  const [fallbackAppId, setFallbackAppId] = useState<string | null>(null);

  useEffect(() => {
    if (app) rememberLastApp(workspaceId, app.id);
  }, [app, workspaceId]);

  useEffect(() => {
    if (app) return;
    const last = readLastApp(workspaceId);
    setFallbackAppId(apps.find((a) => a.id === last)?.id ?? apps[0]?.id ?? null);
  }, [app, apps, workspaceId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tabAppId = app?.id ?? fallbackAppId;
  const switcherApp = app ?? apps.find((a) => a.id === fallbackAppId) ?? null;
  // Home's badge: what waits on the person in this app (the same list Home shows).
  const needs = useNeedsYou(workspaceId, tabAppId, { enabled: Boolean(tabAppId) });
  const waiting = tabAppId ? (needs.data?.count ?? 0) : 0;
  const items = TABS.map((t) => ({ ...t, href: tabHref(workspaceId, tabAppId, t.value), count: t.value === "home" ? waiting : 0 }));
  const inSettings = SETTINGS_SECTIONS.has(section ?? "");

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-line/80 bg-white/80 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto grid h-14 max-w-[1440px] grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 sm:px-5 md:h-16 md:grid-cols-[1fr_auto_1fr]">
          <div className="flex min-w-0 items-center">
            <AppSwitcher app={switcherApp} section={section} />
          </div>
          <nav aria-label="Primary" className="hidden md:block">
            <ul className="flex items-center gap-1.5">
              {items.map((it) => {
                const active = it.value === tab;
                const cls = cn(
                  "inline-flex h-9 items-center gap-1.5 rounded-full px-[18px] text-body-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus",
                  active ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-mist hover:text-ink",
                );
                return (
                  <li key={it.value}>
                    {it.href ? (
                      <Link href={it.href} prefetch={false} aria-current={active ? "page" : undefined} aria-label={tabLabel(it.label, it.count)} className={cls}>
                        {it.label}
                        <CountBadge count={it.count} />
                      </Link>
                    ) : (
                      <span className={cn(cls, "opacity-50")} aria-disabled="true">
                        {it.label}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="flex items-center justify-end gap-0.5 sm:gap-1">
            <Tooltip content="Ask Muse · ⌘K" side="bottom">
              <button type="button" onClick={() => setCmdOpen(true)} aria-label="Ask Muse" aria-keyshortcuts="Meta+K Control+K" className={ICON_BTN}>
                <WandSparkles aria-hidden />
              </button>
            </Tooltip>
            <JobsTray workspaceId={workspaceId} />
            <Tooltip content="Settings" side="bottom">
              <Link href={routes.settings.workspace(workspaceId)} prefetch={false} aria-label="Settings" aria-current={inSettings ? "page" : undefined} className={cn(ICON_BTN, inSettings && "bg-accent-soft text-accent hover:bg-accent-soft hover:text-accent")}>
                <Settings aria-hidden />
              </Link>
            </Tooltip>
            <AccountMenu onAsk={() => setCmdOpen(true)} />
          </div>
        </div>
      </header>

      {/* Phones: room for the fixed tab bar below, so the end of every page (full-bleed ones too) stays visible. */}
      <main id="main" className={cn("flex-1 pb-[calc(4rem_+_env(safe-area-inset-bottom))] md:pb-0", fullBleed && "flex min-h-0 flex-col")}>
        {children}
      </main>

      {/* Phone tab bar */}
      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
        <ul className="mx-auto grid h-16 max-w-md grid-cols-3 px-2">
          {items.map((it) => {
            const active = it.value === tab;
            const inner = (
              <>
                <span className={cn("relative flex h-8 w-14 items-center justify-center rounded-full transition-colors [&_svg]:size-[21px]", active && "bg-accent-soft")}>
                  {it.icon}
                  <CountBadge count={it.count} className="absolute -right-1 -top-1 ring-2 ring-white" />
                </span>
                {it.label}
              </>
            );
            const cls = cn("flex h-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium", active ? "text-accent" : "text-ink-2");
            return (
              <li key={it.value}>
                {it.href ? (
                  <Link href={it.href} prefetch={false} aria-current={active ? "page" : undefined} aria-label={tabLabel(it.label, it.count)} className={cls}>
                    {inner}
                  </Link>
                ) : (
                  <span className={cn(cls, "opacity-50")}>{inner}</span>
                )}
              </li>
            );
          })}
        </ul>
      </nav>

      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </div>
  );
}
