"use client";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../cn";
import { UiLink } from "./link";

export interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** `raised` = white card with hairline; `well` = recessed mist; `plain` = no chrome. */
  tone?: "raised" | "well" | "plain";
  padding?: "none" | "sm" | "md" | "lg";
  interactive?: boolean;
}

export function Card({ tone = "raised", padding = "md", interactive, className, ...rest }: CardProps) {
  return (
    <div
      className={cn(
        "rounded-xl",
        tone === "raised" && "bg-surface shadow-raised",
        tone === "well" && "bg-mist",
        padding === "sm" && "p-3",
        padding === "md" && "p-5",
        padding === "lg" && "p-7",
        interactive && "transition-shadow duration-200 ease-out hover:shadow-[0_6px_20px_-6px_rgb(16_24_40/0.14),0_0_0_1px_rgb(16_24_40/0.07)]",
        className,
      )}
      {...rest}
    />
  );
}

/** Page header: title, optional description and actions. Left-aligned, generous. */
export function PageHeader({ title, description, actions, leading, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; leading?: ReactNode; className?: string }) {
  return (
    <header className={cn("flex flex-col gap-4 pb-8 sm:flex-row sm:items-end sm:justify-between", className)}>
      <div className="min-w-0 space-y-1.5">
        {leading}
        <h1 className="text-title-1 font-semibold text-balance">{title}</h1>
        {description ? <p className="max-w-2xl text-body text-ink-2 text-pretty">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** Section within a page: small heading row + content. */
export function Section({ title, description, actions, children, className }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("space-y-4", className)}>
      {title || actions ? (
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0 space-y-0.5">
            {title ? <h2 className="text-headline font-semibold">{title}</h2> : null}
            {description ? <p className="text-body-sm text-ink-2 text-pretty">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Apple "inset grouped" list container. Children should be <ListRow>s. */
export function List({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <div role="list" aria-label={label} className={cn("overflow-hidden rounded-xl bg-surface shadow-raised", "[&>*+*]:border-t [&>*+*]:border-line", className)}>
      {children}
    </div>
  );
}

export function ListRow({ leading, title, subtitle, trailing, className, onClick, href, children }: { leading?: ReactNode; title: ReactNode; subtitle?: ReactNode; trailing?: ReactNode; className?: string; onClick?: () => void; href?: string; children?: ReactNode }) {
  const inner = (
    <>
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-sm font-medium text-ink">{title}</div>
        {subtitle ? <div className="truncate text-footnote text-ink-2">{subtitle}</div> : null}
        {children}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </>
  );
  const cls = cn("flex min-h-14 items-center gap-3 px-4 py-2.5", (onClick || href) && "transition-colors hover:bg-mist/60", className);
  if (href)
    return (
      <UiLink role="listitem" href={href} className={cls}>
        {inner}
      </UiLink>
    );
  if (onClick)
    return (
      <button role="listitem" type="button" onClick={onClick} className={cn(cls, "w-full text-left")}>
        {inner}
      </button>
    );
  return (
    <div role="listitem" className={cls}>
      {inner}
    </div>
  );
}

export function Divider({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div role="separator" aria-orientation={vertical ? "vertical" : "horizontal"} className={cn(vertical ? "w-px self-stretch bg-line" : "h-px w-full bg-line", className)} />;
}

/** Keyboard key hint. */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded-[5px] border border-line-strong bg-surface px-1 font-sans text-[11px] font-medium text-ink-2", className)}>
      {children}
    </kbd>
  );
}

/** Small key/value stat (only for real, sourced values). */
export function Stat({ label, value, detail, className }: { label: ReactNode; value: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1", className)}>
      <div className="text-footnote text-ink-2">{label}</div>
      <div className="text-title-2 font-semibold tabular">{value}</div>
      {detail ? <div className="text-footnote text-ink-3">{detail}</div> : null}
    </div>
  );
}
