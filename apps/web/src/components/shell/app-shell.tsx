"use client";
import type { App } from "@muselaunch/contracts";
import { Avatar, Badge, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuLink, MenuSeparator, MenuTrigger, SegmentedControl, cn } from "@muselaunch/ui";
import { Activity, BarChart3, Check, ChevronDown, Clapperboard, Compass, CreditCard, Info, LogOut, Plus, Search, Settings, Sparkles } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { AppIcon } from "@/components/app-icon";
import { LogoMark } from "@/components/logo";
import { useAuth } from "@/lib/auth/auth-provider";
import { routes, type PrimaryTab } from "@/lib/routes";
import { useMe, useWorkspace } from "@/lib/workspace";
import { CommandPalette } from "./command-palette";
import { ActivitySheet, JobsTray } from "./jobs-tray";
import { NeedsYouButton, NeedsYouTab } from "@/features/autopilot/needs-you";

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
 * App + workspace switcher. Short on purpose: your apps, Add an app, About your app, Settings
 * (one page with Workspace, Integrations, Team and Credits & billing), and other workspaces.
 * Library and Calendar live in Creator (Videos, Scheduled); Autopilot is reached from Creator.
 */
function AppSwitcher({ app, section }: { app: App | null; section?: string }) {
  const router = useRouter();
  const { workspaceId, workspace, apps } = useWorkspace();
  const me = useMe();
  const r = app ? routes.app(workspaceId, app.id) : null;
  const otherWorkspaces = me.data?.workspaces.filter((w) => w.workspace.id !== workspaceId) ?? [];
  const go = (h: string) => router.push(h);

  return (
    <Menu>
      <MenuTrigger asChild>
        <button
          type="button"
          className="group flex h-9 min-w-0 items-center gap-2 rounded-full pl-1 pr-2.5 transition-colors hover:bg-mist focus-visible:outline-none focus-visible:shadow-focus data-[state=open]:bg-mist"
          aria-label="Switch app, About your app and Settings"
        >
          {app ? <AppIcon app={app} workspaceId={workspaceId} size={28} /> : <LogoMark size={28} />}
          <span className="min-w-0 max-w-[16ch] truncate text-body-sm font-semibold text-ink sm:max-w-[22ch]">{app?.name ?? workspace?.name ?? "Workspace"}</span>
          <ChevronDown className="size-3.5 shrink-0 text-ink-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden />
        </button>
      </MenuTrigger>
      <MenuContent className="w-72">
        {apps.length ? <MenuLabel>Apps in {workspace?.name ?? "this workspace"}</MenuLabel> : null}
        {apps.map((a) => (
          <MenuLink key={a.id} href={routes.app(workspaceId, a.id).creator} icon={<AppIcon app={a} workspaceId={workspaceId} size={18} />} trailing={a.id === app?.id ? <Check className="size-4 text-accent" /> : null} onNavigate={go}>
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
          <MenuLink key={w.workspace.id} href={routes.workspace(w.workspace.id)} icon={<Avatar name={w.workspace.name} size={18} shape="squircle" />} onNavigate={(h) => router.push(h)}>
            {w.workspace.name}
          </MenuLink>
        ))}
        <MenuLink href={`${routes.onboarding()}?new=1`} icon={<Plus />} onNavigate={(h) => router.push(h)}>
          New workspace
        </MenuLink>
      </MenuContent>
    </Menu>
  );
}

function AccountMenu() {
  const { user, signOut, mode } = useAuth();
  const router = useRouter();
  const { credits, workspaceId } = useWorkspace();
  const [activity, setActivity] = useState(false);
  return (
    <>
    <Menu>
      <MenuTrigger asChild>
        <button type="button" aria-label="Account" className="rounded-full focus-visible:outline-none focus-visible:shadow-focus">
          <Avatar src={user?.photoUrl} name={user?.name ?? user?.email} size={30} />
        </button>
      </MenuTrigger>
      <MenuContent align="end" className="w-64">
        <div className="px-2.5 pb-2 pt-1.5">
          <p className="truncate text-body-sm font-medium">{user?.name ?? user?.email}</p>
          {user?.name ? <p className="truncate text-footnote text-ink-2">{user.email}</p> : null}
          {mode === "dev" ? <p className="mt-1 text-caption text-warning">Local dev sign-in</p> : null}
        </div>
        <MenuSeparator />
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

const TAB_ICON: Record<PrimaryTab, ReactNode> = {
  discover: <Compass aria-hidden />,
  creator: <Clapperboard aria-hidden />,
  insights: <BarChart3 aria-hidden />,
};

function tabItems(wid: string, appId: string | null) {
  const r = appId ? routes.app(wid, appId) : null;
  return (["discover", "creator", "insights"] as const).map((t) => ({
    value: t,
    label: t === "discover" ? "Discover" : t === "creator" ? "Creator" : "Insights",
    icon: TAB_ICON[t],
    href: r ? r[t] : undefined,
    disabled: !r,
  }));
}

/**
 * The app frame: a calm translucent top bar with the app switcher, EXACTLY three primary tabs
 * (Discover, Creator, Insights) plus "Needs you" (every decision waiting on a person, with a
 * count), Ask Muse (⌘K) and the account menu (Credits, Activity, Sign out). The jobs icon only shows
 * while something is running; Autopilot's status lives on Creator → Today. On phones the tabs and
 * Needs you move to a bottom tab bar.
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
  const items = tabItems(workspaceId, tabAppId);
  const renderLink = (p: { href: string; className: string; children: ReactNode; "aria-current"?: "page" }) => (
    <Link href={p.href} className={p.className} aria-current={p["aria-current"]} prefetch={false}>
      {p.children}
    </Link>
  );

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-40 border-b border-line/80 bg-white/80 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto grid h-14 max-w-[1440px] grid-cols-[minmax(0,1fr)_auto] md:grid-cols-[1fr_auto_1fr] items-center gap-3 px-3 sm:px-5">
          <div className="flex min-w-0 items-center">
            <AppSwitcher app={switcherApp} section={section} />
          </div>
          <nav aria-label="Primary" className="hidden items-center gap-2 md:flex">
            <SegmentedControl label="Primary" items={items} value={(tab ?? "") as PrimaryTab} renderLink={renderLink} size="md" />
            <NeedsYouButton workspaceId={workspaceId} current={section === "needs-you"} />
          </nav>
          <div className="flex items-center justify-end gap-1 sm:gap-1.5">
            <button
              type="button"
              onClick={() => setCmdOpen(true)}
              className="hidden h-8 items-center gap-2 rounded-full border border-line bg-surface pl-3 pr-1.5 text-footnote text-ink-2 transition-colors hover:border-line-strong hover:text-ink focus-visible:outline-none focus-visible:shadow-focus lg:inline-flex"
            >
              <Sparkles className="size-3.5 text-accent" aria-hidden />
              Ask Muse
              <Kbd className="ml-3">⌘K</Kbd>
            </button>
            <button
              type="button"
              onClick={() => setCmdOpen(true)}
              aria-label="Ask Muse"
              className="inline-flex size-8 items-center justify-center rounded-full text-ink-2 hover:bg-mist hover:text-ink lg:hidden"
            >
              <Search className="size-[18px]" aria-hidden />
            </button>
            <JobsTray workspaceId={workspaceId} />
            <AccountMenu />
          </div>
        </div>
      </header>

      {/* Phones: room for the fixed tab bar below, so the end of every page (full-bleed ones too) stays visible. */}
      <main id="main" className={cn("flex-1 pb-[calc(3.5rem_+_env(safe-area-inset-bottom))] md:pb-0", fullBleed && "flex min-h-0 flex-col")}>
        {children}
      </main>

      {/* Phone tab bar */}
      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-white/85 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl md:hidden">
        <ul className="grid h-14 grid-cols-4">
          {items.map((it) => {
            const active = it.value === tab;
            return (
              <li key={it.value}>
                {it.href ? (
                  <Link
                    href={it.href}
                    prefetch={false}
                    aria-current={active ? "page" : undefined}
                    className={cn("flex h-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium [&_svg]:size-[22px]", active ? "text-accent" : "text-ink-3")}
                  >
                    {it.icon}
                    {it.label}
                  </Link>
                ) : (
                  <span className="flex h-full flex-col items-center justify-center gap-0.5 text-[11px] font-medium text-ink-3 opacity-50 [&_svg]:size-[22px]">
                    {it.icon}
                    {it.label}
                  </span>
                )}
              </li>
            );
          })}
          <li>
            <NeedsYouTab workspaceId={workspaceId} active={section === "needs-you"} />
          </li>
        </ul>
      </nav>

      <CommandPalette open={cmdOpen} onOpenChange={setCmdOpen} />
    </div>
  );
}
