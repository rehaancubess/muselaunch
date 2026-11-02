"use client";
import { cn } from "@muselaunch/ui";
import { CreditCard, Plug, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { AppIcon } from "@/components/app-icon";
import { BackLink } from "@/components/back-link";
import { PageContainer } from "@/components/page-container";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

/**
 * Settings: "The basics" and "More settings" on the main page (/settings); Connected accounts & AI
 * (/settings/integrations), Team and Credits & billing keep their own pages and URLs. Desktop lists
 * them in a sidebar; phones open them from More settings and get a "‹ Settings" link back (no
 * sideways-scrolling switcher). Each app's "About your app" is linked from here too.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { workspaceId, workspace, apps } = useWorkspace();
  const pathname = usePathname() ?? "";
  const items = [
    { value: "settings", label: "General", href: routes.settings.workspace(workspaceId), icon: <Settings aria-hidden /> },
    { value: "integrations", label: "Integrations", href: routes.settings.integrations(workspaceId), icon: <Plug aria-hidden /> },
    { value: "team", label: "Team", href: routes.settings.team(workspaceId), icon: <Users aria-hidden /> },
    { value: "credits", label: "Credits & billing", href: routes.settings.credits(workspaceId), icon: <CreditCard aria-hidden /> },
  ];
  const current = items.find((i) => i.value !== "settings" && pathname.startsWith(i.href))?.value ?? "settings";
  const link = "flex h-9 items-center gap-2.5 rounded-lg px-3 text-body-sm transition-colors focus-visible:outline-none focus-visible:shadow-focus [&_svg]:size-4";
  return (
    <PageContainer width="wide">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
        <aside className={cn("min-w-0 lg:pt-1", current === "settings" && "hidden lg:block")}>
          <p className="mb-3 hidden truncate px-3 text-footnote font-medium text-ink-3 lg:block">{workspace?.name}</p>
          <nav aria-label="Settings" className="hidden lg:block">
            <ul className="space-y-0.5">
              {items.map((i) => (
                <li key={i.value}>
                  <Link href={i.href} aria-current={i.value === current ? "page" : undefined} className={cn(link, i.value === current ? "bg-mist font-medium text-ink" : "text-ink-2 hover:bg-mist/60 hover:text-ink")}>
                    {i.icon}
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
            {apps.length ? (
              <>
                <p className="mb-1 mt-6 px-3 text-caption font-medium text-ink-3">About your apps</p>
                <ul className="space-y-0.5">
                  {apps.map((a) => (
                    <li key={a.id}>
                      <Link href={routes.app(workspaceId, a.id).about} className={cn(link, "text-ink-2 hover:bg-mist/60 hover:text-ink")}>
                        <AppIcon app={a} workspaceId={workspaceId} size={18} />
                        <span className="min-w-0 truncate">{a.name}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
          </nav>
          {/* Phones, on a sub-page: back to the main Settings page (More settings lists every page). */}
          {current !== "settings" ? (
            <div className="-mb-4 lg:hidden">
              <BackLink href={routes.settings.workspace(workspaceId)}>Settings</BackLink>
            </div>
          ) : null}
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </PageContainer>
  );
}
