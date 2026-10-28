import { cn } from "@muselaunch/ui";
import { Lock } from "lucide-react";
import type { ReactNode } from "react";

/** A quiet desktop-browser frame for real product screenshots. */
export function BrowserFrame({ children, label = "MuseLaunch", className }: { children: ReactNode; label?: string; className?: string }) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-[10px] bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.07),0_2px_6px_-2px_rgb(0_0_0/0.06),0_32px_72px_-24px_rgb(0_0_0/0.28)] sm:rounded-[14px]",
        className,
      )}
    >
      <div aria-hidden className="grid h-7 grid-cols-[1fr_auto_1fr] items-center border-b border-line bg-[#fbfbfd] px-3 sm:h-10 sm:px-4">
        <div className="flex gap-1 sm:gap-1.5">
          <span className="size-[7px] rounded-full bg-[#d9d9de] sm:size-[11px]" />
          <span className="size-[7px] rounded-full bg-[#d9d9de] sm:size-[11px]" />
          <span className="size-[7px] rounded-full bg-[#d9d9de] sm:size-[11px]" />
        </div>
        <div className="flex h-[18px] w-[min(46vw,300px)] items-center justify-center gap-1 rounded-[5px] bg-mist text-[9px] font-medium text-ink-2 sm:h-6 sm:gap-1.5 sm:rounded-md sm:text-caption">
          <Lock className="size-2 sm:size-3" />
          {label}
        </div>
        <span />
      </div>
      {children}
    </div>
  );
}

/**
 * A phone with a 9:16 screen. Sizes scale with the frame's own width (container query units),
 * so set the width with `className` and everything else follows.
 */
export function PhoneFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("@container", className)}>
      <div className="relative rounded-[15cqw] bg-black p-[3.4cqw] shadow-[0_0_0_1px_#48484c,inset_0_0_0_1px_#2c2c2e,0_40px_80px_-28px_rgb(0_0_0/0.55),0_12px_24px_-12px_rgb(0_0_0/0.3)]">
        <div className="relative aspect-[9/16] overflow-hidden rounded-[11.6cqw] bg-[#2b2622]">
          {children}
          <span aria-hidden className="absolute left-1/2 top-[3cqw] z-10 h-[8cqw] w-[27cqw] -translate-x-1/2 rounded-full bg-black" />
        </div>
      </div>
    </div>
  );
}

/** A screenshot set on a soft panel, with an honest caption underneath. */
export function ShotPanel({ children, caption, className }: { children: ReactNode; caption?: ReactNode; className?: string }) {
  return (
    <figure className={className}>
      <div className="rounded-[20px] bg-mist p-3 sm:rounded-[28px] sm:p-8 lg:p-10">{children}</div>
      {caption ? <figcaption className="mt-3 px-1 text-footnote text-ink-2 text-pretty">{caption}</figcaption> : null}
    </figure>
  );
}

/** White card that holds a cropped product screenshot. */
export function ShotCard({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-hidden rounded-[10px] bg-white shadow-[0_0_0_1px_rgb(0_0_0/0.06),0_18px_40px_-20px_rgb(0_0_0/0.25)] sm:rounded-[14px]", className)}>
      {children}
    </div>
  );
}
