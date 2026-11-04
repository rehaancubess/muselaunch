"use client";
import { Kbd, cn } from "@muselaunch/ui";
import { Command } from "cmdk";
import { BarChart3, CalendarDays, Clapperboard, Compass, CreditCard, FolderOpen, House, Info, Plug, Plus, Rocket, Settings, Sparkles, Users, Wand2 } from "lucide-react";
import { Dialog as D } from "radix-ui";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { AppIcon } from "@/components/app-icon";
import { emitAiEdit, useOpenCommandListener } from "@/lib/commands";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

function Item({ children, onSelect, icon, hint, value }: { children: ReactNode; onSelect: () => void; icon: ReactNode; hint?: ReactNode; value: string }) {
  return (
    <Command.Item value={value} onSelect={onSelect} className="flex h-11 cursor-default select-none items-center gap-3 rounded-lg px-3 text-body-sm text-ink outline-none [&_svg]:size-4">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-mist text-ink-2">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint ? <span className="shrink-0 text-footnote text-ink-3">{hint}</span> : null}
    </Command.Item>
  );
}

/**
 * Global "Ask Muse" palette (⌘K). Free text routes to campaign creation, or to an AI edit when
 * a composition is open in the Studio. Also navigation and app switching.
 */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { workspaceId, app, apps } = useWorkspace();
  const [text, setText] = useState("");

  const studioMatch = pathname.match(/\/creator\/studio\/([A-Za-z0-9_-]+)/);
  const compositionId = studioMatch?.[1];

  useEffect(() => {
    if (!open) setText("");
  }, [open]);

  useOpenCommandListener(
    useCallback(
      (prefill?: string) => {
        setText(prefill ?? "");
        onOpenChange(true);
      },
      [onOpenChange],
    ),
  );

  const go = (href: string) => {
    onOpenChange(false);
    router.push(href);
  };

  const r = app ? routes.app(workspaceId, app.id) : null;
  const trimmed = text.trim();

  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[rgb(29_29_31/0.22)] backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <D.Content className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-24px)] max-w-[620px] -translate-x-1/2 overflow-hidden rounded-2xl bg-surface shadow-float focus:outline-none data-[state=open]:animate-scale-in">
          <D.Title className="sr-only">Ask Muse</D.Title>
          <D.Description className="sr-only">Describe what you want to make, or jump to a section.</D.Description>
          <Command label="Ask Muse" shouldFilter={true} loop>
            <div className="flex items-center gap-3 border-b border-line px-4">
              <Sparkles className="size-[18px] shrink-0 text-accent" aria-hidden />
              <Command.Input
                value={text}
                onValueChange={setText}
                placeholder={compositionId ? "Describe a change to this video, or search…" : "Describe a campaign, or search…"}
                className="h-14 w-full bg-transparent text-body text-ink outline-none placeholder:text-ink-3"
              />
              <Kbd className="hidden sm:inline-flex">esc</Kbd>
            </div>
            <Command.List className="max-h-[min(440px,60dvh)] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-8 text-center text-body-sm text-ink-2">No matches. Press Enter on an action above to use your words as a request.</Command.Empty>

              {trimmed && r ? (
                <Command.Group heading="Ask Muse" forceMount>
                  {compositionId ? (
                    <Item
                      value={`__edit ${trimmed}`}
                      icon={<Wand2 aria-hidden />}
                      hint="Edits this video"
                      onSelect={() => {
                        emitAiEdit({ compositionId, instruction: trimmed });
                        onOpenChange(false);
                      }}
                    >
                      Edit video: <span className="text-ink-2">“{trimmed}”</span>
                    </Item>
                  ) : null}
                  <Item value={`__autopilot ${trimmed}`} icon={<Rocket aria-hidden />} hint="Asks before anything goes out" onSelect={() => go(`${r.autopilot}?goal=${encodeURIComponent(trimmed)}`)}>
                    Start Autopilot: <span className="text-ink-2">“{trimmed}”</span>
                  </Item>
                  <Item value={`__campaign ${trimmed}`} icon={<Clapperboard aria-hidden />} hint="New campaign" onSelect={() => go(`${r.newCampaign}?request=${encodeURIComponent(trimmed)}`)}>
                    Create campaign: <span className="text-ink-2">“{trimmed}”</span>
                  </Item>
                </Command.Group>
              ) : null}

              {r ? (
                <Command.Group heading={app?.name ?? "App"}>
                  <Item value="home today review posts approve needs you decisions coming up" icon={<House aria-hidden />} onSelect={() => go(r.home)}>
                    Home
                  </Item>
                  <Item value="create make video promote feature idea campaigns creator" icon={<Sparkles aria-hidden />} onSelect={() => go(r.create())}>
                    Create
                  </Item>
                  <Item value="results insights analytics metrics views clicks what is working" icon={<BarChart3 aria-hidden />} onSelect={() => go(r.results)}>
                    Results
                  </Item>
                  <Item value="ideas discover trends competitors research findings sources" icon={<Compass aria-hidden />} onSelect={() => go(r.discoverAll)} hint="Create">
                    Everything Muse found
                  </Item>
                  <Item value="insights details tests experiments data sources csv revenuecat" icon={<BarChart3 aria-hidden />} onSelect={() => go(r.insightsDetails())} hint="Results">
                    Results in detail
                  </Item>
                  <Item value="autopilot growth autonomous loop goal" icon={<Rocket aria-hidden />} onSelect={() => go(r.autopilot)}>
                    Autopilot
                  </Item>
                  <Item value="new campaign" icon={<Plus aria-hidden />} onSelect={() => go(r.newCampaign)}>
                    New campaign
                  </Item>
                  <Item value="videos files library assets uploads media screenshots renders" icon={<FolderOpen aria-hidden />} onSelect={() => go(r.videos)} hint="Create">
                    Videos and files
                  </Item>
                  <Item value="scheduled posts calendar publishing schedule" icon={<CalendarDays aria-hidden />} onSelect={() => go(r.scheduled)} hint="Create">
                    Scheduled posts
                  </Item>
                  <Item value="about your app dna brand kit facts claims audiences features" icon={<Info aria-hidden />} onSelect={() => go(r.about)}>
                    About your app
                  </Item>
                </Command.Group>
              ) : null}

              <Command.Group heading="Workspace">
                <Item value="settings workspace autopilot sound profile" icon={<Settings aria-hidden />} onSelect={() => go(routes.settings.workspace(workspaceId))}>
                  Settings
                </Item>
                <Item value="integrations providers connections models" icon={<Plug aria-hidden />} onSelect={() => go(routes.settings.integrations(workspaceId))}>
                  Integrations
                </Item>
                <Item value="team members invite" icon={<Users aria-hidden />} onSelect={() => go(routes.settings.team(workspaceId))}>
                  Team
                </Item>
                <Item value="credits billing plan usage" icon={<CreditCard aria-hidden />} onSelect={() => go(routes.settings.credits(workspaceId))}>
                  Credits &amp; billing
                </Item>
              </Command.Group>

              {apps.length > 1 ? (
                <Command.Group heading="Switch app">
                  {apps
                    .filter((a) => a.id !== app?.id)
                    .map((a) => (
                      <Item key={a.id} value={`switch ${a.name}`} icon={<AppIcon app={a} workspaceId={workspaceId} size={18} />} onSelect={() => go(routes.app(workspaceId, a.id).home)}>
                        {a.name}
                      </Item>
                    ))}
                </Command.Group>
              ) : null}
            </Command.List>
            <div className={cn("flex items-center gap-4 border-t border-line px-4 py-2.5 text-caption text-ink-3")}>
              <span className="flex items-center gap-1.5">
                <Kbd>↑</Kbd>
                <Kbd>↓</Kbd> to move
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd> to run
              </span>
              <span className="ml-auto hidden sm:inline">Nothing is published without your approval</span>
            </div>
          </Command>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
