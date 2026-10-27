"use client";
import { SegmentedControl, cn } from "@muselaunch/ui";
import { CreditCard, Plug, Settings, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { PageContainer } from "@/components/page-container";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const { workspaceId, workspace } = useWorkspace();
  const pathname = usePathname() ?? "";
  const items = [
    { value: "integrations", label: "Integrations", href: routes.settings.integrations(workspaceId), icon: <Plug aria-hidden /> },
    { value: "team", label: "Team", href: routes.settings.team(workspaceId), icon: <Users aria-hidden /> },
    { value: "credits", label: "Credits & billing", href: routes.settings.credits(workspaceId), icon: <CreditCard aria-hidden /> },
    { value: "settings", label: "Workspace", href: routes.settings.workspace(workspaceId), icon: <Settings aria-hidden /> },
  ];
  const current = items.find((i) => i.value !== "settings" && pathname.startsWith(i.href))?.value ?? "settings";
  return (
    <PageContainer width="wide">
      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-12">
        <aside className="lg:pt-1">
          <p className="mb-3 hidden truncate px-3 text-footnote font-medium text-ink-3 lg:block">{workspace?.name}</p>
          <nav aria-label="Settings" className="hidden lg:block">
            <ul className="space-y-0.5">
              {items.map((i) => (
                <li key={i.value}>
                  <Link
                    href={i.href}
                    aria-current={i.value === current ? "page" : undefined}
                    className={cn(
                      "flex h-9 items-center gap-2.5 rounded-lg px-3 text-body-sm transition-colors [&_svg]:size-4",
                      i.value === current ? "bg-mist font-medium text-ink" : "text-ink-2 hover:bg-mist/60 hover:text-ink",
                    )}
                  >
                    {i.icon}
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="-mx-1 overflow-x-auto px-1 pb-1 lg:hidden">
            <SegmentedControl
              label="Settings"
              size="sm"
              value={current}
              items={items.map(({ value, label, href }) => ({ value, label, href }))}
              renderLink={(p) => (
                <Link href={p.href} className={p.className} aria-current={p["aria-current"]}>
                  {p.children}
                </Link>
              )}
            />
          </div>
        </aside>
        <div className="min-w-0">{children}</div>
      </div>
    </PageContainer>
  );
}
