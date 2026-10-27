import { cn } from "@muselaunch/ui";

/** MuseLaunch mark: a rising trajectory leaving a point, set in the accent. */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className={cn("shrink-0", className)}>
      <rect width="32" height="32" rx="9" fill="var(--ml-accent)" />
      <path d="M8.5 22.5c3.2-.4 6.7-2.3 9.4-5.6 1.8-2.2 3-4.6 3.6-7" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="22.6" cy="8.6" r="2.4" fill="#fff" />
      <circle cx="9" cy="22.4" r="1.5" fill="#fff" fillOpacity=".55" />
    </svg>
  );
}

export function Logo({ className, size = 24 }: { className?: string; size?: number }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark size={size} />
      <span className="text-[17px] font-semibold tracking-[-0.02em] text-ink">MuseLaunch</span>
    </span>
  );
}
