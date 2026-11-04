import { ChevronLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

/** "‹ Parent page" above a page title (a 44 px tap target). */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="-ml-1.5 inline-flex min-h-11 items-center gap-0.5 rounded-lg pl-0.5 pr-2 text-body-sm font-medium text-accent hover:text-accent-hover focus-visible:outline-none focus-visible:shadow-focus">
      <ChevronLeft className="size-4" aria-hidden />
      {children}
    </Link>
  );
}
