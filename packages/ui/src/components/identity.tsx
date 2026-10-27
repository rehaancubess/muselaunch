"use client";
import type { SourceRef } from "@muselaunch/contracts";
import { Avatar as AvatarPrimitive } from "radix-ui";
import { FileText, Globe, Image as ImageIcon, Plus, ShoppingBag, Sparkles, Upload, User, Video, Search, Database } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../cn";

// ---------------------------------------------------------------- Avatar

export function initialsOf(name?: string | null): string {
  if (!name) return "?";
  const parts = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || name[0]!.toUpperCase();
}

/** Deterministic, quiet background for initials (no rainbow). */
function tintFor(seed: string) {
  const tints = ["#E9EDFF", "#E7F4EE", "#F3ECFA", "#FFF1E3", "#E6F2F8", "#F1F1F4"];
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return tints[h % tints.length];
}

export function Avatar({ src, name, size = 32, shape = "circle", className }: { src?: string | null; name?: string | null; size?: number; shape?: "circle" | "squircle"; className?: string }) {
  return (
    <AvatarPrimitive.Root
      className={cn("relative inline-flex shrink-0 select-none items-center justify-center overflow-hidden", shape === "circle" ? "rounded-full" : "rounded-[22%]", className)}
      style={{ width: size, height: size, background: tintFor(name ?? "?") }}
    >
      {src ? <AvatarPrimitive.Image src={src} alt={name ?? ""} className="size-full object-cover" /> : null}
      <AvatarPrimitive.Fallback delayMs={src ? 400 : 0} className="font-semibold text-ink/70" style={{ fontSize: Math.max(10, Math.round(size * 0.38)) }}>
        {initialsOf(name)}
      </AvatarPrimitive.Fallback>
    </AvatarPrimitive.Root>
  );
}

// ---------------------------------------------------------------- StoryRing row

export interface StoryItem {
  id: string;
  label: string;
  avatarUrl?: string;
  /** `new` = unseen observations (accent ring), `seen` = hairline ring. */
  ring?: "new" | "seen" | "none";
  sublabel?: string;
  onClick?: () => void;
}

/** Instagram-Stories-style row of tracked accounts. Scrolls horizontally with snap. */
export function StoryRingRow({ items, onAdd, addLabel = "Track", className, label = "Tracked accounts" }: { items: StoryItem[]; onAdd?: () => void; addLabel?: string; className?: string; label?: string }) {
  return (
    <div role="list" aria-label={label} className={cn("-mx-1 flex snap-x gap-4 overflow-x-auto px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      {onAdd ? (
        <div role="listitem" className="snap-start">
          <button type="button" onClick={onAdd} className="group flex w-[72px] flex-col items-center gap-1.5 focus-visible:outline-none">
            <span className="flex size-[64px] items-center justify-center rounded-full border border-dashed border-line-strong text-ink-2 transition-colors group-hover:border-ink-3 group-hover:text-ink group-focus-visible:shadow-focus">
              <Plus className="size-5" aria-hidden />
            </span>
            <span className="w-full truncate text-center text-caption text-ink-2">{addLabel}</span>
          </button>
        </div>
      ) : null}
      {items.map((it) => (
        <div role="listitem" key={it.id} className="snap-start">
          <button type="button" onClick={it.onClick} className="group flex w-[72px] flex-col items-center gap-1.5 focus-visible:outline-none" title={it.sublabel ? `${it.label}, ${it.sublabel}` : it.label}>
            <span
              className={cn(
                "flex size-[64px] items-center justify-center rounded-full p-[2.5px] transition-transform duration-200 ease-out group-hover:scale-[1.03] group-focus-visible:shadow-focus",
                it.ring === "new" && "bg-[conic-gradient(from_200deg,var(--ml-accent),#7b8cff,var(--ml-accent))]",
                it.ring === "seen" && "bg-line-strong",
              )}
            >
              <span className="flex size-full items-center justify-center rounded-full bg-surface p-[2px]">
                <Avatar src={it.avatarUrl} name={it.label} size={54} />
              </span>
            </span>
            <span className="w-full truncate text-center text-caption text-ink">{it.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- SourceChip

const SOURCE_ICON: Record<string, ReactNode> = {
  url: <Globe aria-hidden />,
  search_result: <Search aria-hidden />,
  store_listing: <ShoppingBag aria-hidden />,
  upload: <Upload aria-hidden />,
  screenshot: <ImageIcon aria-hidden />,
  recording: <Video aria-hidden />,
  document: <FileText aria-hidden />,
  user_input: <User aria-hidden />,
  api: <Database aria-hidden />,
  model_inference: <Sparkles aria-hidden />,
};

const SOURCE_KIND_LABEL: Record<string, string> = {
  store_listing: "Store listing",
  upload: "Your upload",
  screenshot: "Screenshot",
  recording: "Recording",
  document: "Document",
  user_input: "You",
  api: "Connected API",
  model_inference: "Model inference",
};

export function domainOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function formatShortDate(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: sameYear ? undefined : "numeric" });
}

/** Citation chip: domain + title + retrieved date. Every research finding must show at least one. */
export function SourceChip({ source, className, compact }: { source: Pick<SourceRef, "kind" | "url" | "title" | "publisher" | "retrievedAt">; className?: string; compact?: boolean }) {
  const domain = domainOf(source.url);
  const head = domain ?? source.publisher ?? SOURCE_KIND_LABEL[source.kind] ?? source.kind;
  const date = formatShortDate(source.retrievedAt);
  const inferred = source.kind === "model_inference";
  const body = (
    <>
      <span className="shrink-0 text-ink-3 [&_svg]:size-3">{SOURCE_ICON[source.kind] ?? <Globe aria-hidden />}</span>
      <span className="shrink-0 font-medium text-ink">{head}</span>
      {!compact && source.title ? <span className="min-w-0 truncate text-ink-2">{source.title}</span> : null}
      {date ? <span className="shrink-0 tabular text-ink-3">{inferred ? date : `Retrieved ${date}`}</span> : null}
    </>
  );
  const cls = cn(
    "inline-flex h-6 max-w-full items-center gap-1.5 rounded-full border px-2 text-caption",
    inferred ? "border-dashed border-line-strong bg-surface" : "border-line bg-mist/70",
    source.url && "transition-colors hover:border-line-strong hover:bg-mist",
    className,
  );
  if (source.url) {
    return (
      <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" className={cls} title={source.title ?? source.url}>
        {body}
      </a>
    );
  }
  return (
    <span className={cls} title={inferred ? "Interpretation by the model, not an external fact" : source.title}>
      {body}
    </span>
  );
}
