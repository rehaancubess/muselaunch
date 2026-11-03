import type { Channel } from "@muselaunch/contracts";
import { cn } from "@muselaunch/ui";
import { CHANNEL_LABEL } from "@/lib/labels";

/**
 * A small, recognisable mark for where a post goes (Instagram, TikTok, YouTube…), always next to the
 * channel's name: the mark helps scanning, the words carry the meaning. Other channels get a quiet
 * initial. Decorative (aria-hidden).
 */
export function ChannelMark({ channel, size = 16, className }: { channel: Channel; size?: number; className?: string }) {
  const box = cn("inline-flex shrink-0 items-center justify-center overflow-hidden", className);
  const style = { width: size, height: size, borderRadius: size * 0.28 };
  if (channel === "instagram") {
    return (
      <span aria-hidden className={box} style={{ ...style, background: "radial-gradient(circle at 30% 107%, #fdf497 0%, #fdf497 5%, #fd5949 45%, #d6249f 60%, #285aeb 90%)" }}>
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none" stroke="#fff" strokeWidth="1.5">
          <rect x="3.5" y="3.5" width="9" height="9" rx="2.8" />
          <circle cx="8" cy="8" r="2.1" />
          <circle cx="11" cy="5" r="0.55" fill="#fff" stroke="none" />
        </svg>
      </span>
    );
  }
  if (channel === "youtube") {
    return (
      <span aria-hidden className={box} style={{ ...style, background: "#ff0033" }}>
        <svg viewBox="0 0 16 16" width={size} height={size}>
          <path d="M6.4 5.3v5.4L10.9 8z" fill="#fff" />
        </svg>
      </span>
    );
  }
  if (channel === "tiktok") {
    return (
      <span aria-hidden className={box} style={{ ...style, background: "#111" }}>
        <svg viewBox="0 0 16 16" width={size} height={size} fill="none" strokeLinecap="round">
          <path d="M8.6 3.6v6.3a2 2 0 1 1-2-2" stroke="#25f4ee" strokeWidth="1.5" transform="translate(-0.5 0.4)" />
          <path d="M8.6 3.6v6.3a2 2 0 1 1-2-2" stroke="#fe2c55" strokeWidth="1.5" transform="translate(0.5 -0.2)" />
          <path d="M8.6 3.6v6.3a2 2 0 1 1-2-2M8.6 3.6c.3 1.5 1.3 2.4 2.8 2.5" stroke="#fff" strokeWidth="1.5" />
        </svg>
      </span>
    );
  }
  const initial = (CHANNEL_LABEL[channel] ?? channel).charAt(0).toUpperCase();
  return (
    <span aria-hidden className={cn(box, "bg-ink/80 font-semibold text-white")} style={{ ...style, fontSize: Math.round(size * 0.6), lineHeight: 1 }}>
      {initial}
    </span>
  );
}

/** "[mark] Instagram" */
export function ChannelName({ channel, size = 16, className }: { channel: Channel; size?: number; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <ChannelMark channel={channel} size={size} />
      <span className="truncate">{CHANNEL_LABEL[channel] ?? channel}</span>
    </span>
  );
}
