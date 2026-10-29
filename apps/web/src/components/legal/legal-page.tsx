import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/logo";

/** Operator and contact for the public legal pages (set at build time; see .env.example). */
export const legal = {
  operator: process.env.NEXT_PUBLIC_OPERATOR_NAME || "the MuseLaunch developer",
  email: process.env.NEXT_PUBLIC_CONTACT_EMAIL || "",
  updated: "29 October 2026",
};

/** "email us at x" when a contact address is configured; an honest placeholder when it isn't. */
export function ContactLine({ subject }: { subject?: string }) {
  if (!legal.email) return <span className="font-medium text-warning">[contact email not configured yet]</span>;
  const href = `mailto:${legal.email}${subject ? `?subject=${encodeURIComponent(subject)}` : ""}`;
  return (
    <a href={href} className="font-medium text-accent underline underline-offset-2">
      {legal.email}
    </a>
  );
}

const LINKS = [
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/data-deletion", label: "Data deletion" },
];

export function LegalPage({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4 sm:px-6">
        <Link href="/" aria-label="MuseLaunch home">
          <Logo size={22} />
        </Link>
        <nav aria-label="Legal" className="flex gap-4 text-footnote">
          {LINKS.map((l) => (
            <Link key={l.href} href={l.href} className="text-ink-2 hover:text-ink">
              {l.label}
            </Link>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-3xl px-4 pb-24 pt-10 sm:px-6">
        <h1 className="text-title-1 font-semibold text-balance">{title}</h1>
        <p className="mt-2 text-footnote text-ink-3">Last updated {legal.updated}</p>
        {intro ? <div className="mt-6 text-body text-ink-2 text-pretty">{intro}</div> : null}
        <div className="legal-prose mt-8 space-y-8 text-body text-ink-2">{children}</div>
      </main>
    </div>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-title-3 font-semibold text-ink">{title}</h2>
      {children}
    </section>
  );
}

export function List({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 marker:text-ink-3">{children}</ul>;
}

export function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent underline underline-offset-2">
      {children}
    </a>
  );
}
