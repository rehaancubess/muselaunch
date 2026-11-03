import { cn } from "@muselaunch/ui";

/** The four-point sparkle in the mark (32×32 box), shared with the favicon (app/icon.svg). */
export const SPARKLE_PATH = "M16 6C17.2 12 20 14.8 26 16 20 17.2 17.2 20 16 26 14.8 20 12 17.2 6 16 12 14.8 14.8 12 16 6Z";

/**
 * MuseLaunch mark: a rounded square in the brand gradient (monochrome, or the current app's colour) with a white four-point sparkle.
 * The gradient is a CSS background (no SVG ids, so any number of marks can share a page).
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("relative inline-flex shrink-0 items-center justify-center overflow-hidden shadow-[inset_0_0_0_0.5px_rgb(255_255_255/0.18),0_1px_2px_rgb(0_0_0/0.2)]", className)}
      style={{ width: size, height: size, borderRadius: size * 0.28, backgroundImage: "var(--ml-brand-gradient)" }}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" className="block">
        <path d={SPARKLE_PATH} fill="#fff" />
      </svg>
    </span>
  );
}

export function Logo({ className, size = 24, tagline }: { className?: string; size?: number; tagline?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={size} />
      <span className="flex flex-col">
        <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink">MuseLaunch</span>
        {tagline ? <span className="text-caption text-ink-2">Create. Review. Grow.</span> : null}
      </span>
    </span>
  );
}
