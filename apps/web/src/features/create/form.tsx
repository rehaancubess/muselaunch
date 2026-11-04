"use client";
/**
 * Create's form pieces: the three big choices, the feature chips, the one-line prompt that grows,
 * "Make a…" (Video · Post · Carousel · More), the choices each one needs (Format / Length, Where,
 * Shape, Slides, Store) and the "Generate carousel | N credits" button (the real estimate).
 */
import type { Channel, StoreTarget } from "@muselaunch/contracts";
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Popover, Spinner, cn } from "@muselaunch/ui";
import { Check, ChevronDown, Clapperboard, Clock, GalleryHorizontalEnd, Image as ImageIcon, Layers, Megaphone, RectangleHorizontal, RectangleVertical, Smartphone, Sparkle, Square, SquarePlay, Type } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { ChannelMark } from "@/components/channel-mark";
import { CHANNEL_LABEL } from "@/lib/labels";
import { CREATE_KINDS, FORMATS, KIND_LABEL, MAIN_MAKES, MAX_PROMPT, MORE_MAKES, SHAPES, type CreateKind, type FormatId, type MakeFormat, type Shape } from "./plan";

const KIND_ICON: Record<CreateKind, ReactNode> = {
  promote: <Megaphone aria-hidden />,
  feature: <SquarePlay aria-hidden />,
  idea: <Sparkle aria-hidden />,
};

/** The selected look shared by cards and chips: accent outline and a check. */
const SELECTED = "border-accent bg-accent-soft/60 shadow-[0_0_0_1px_var(--ml-accent)]";

/** "What would you like to make?": three big cards (rows on a phone). */
export function KindChoices({ value, onChange, disabled }: { value: CreateKind; onChange: (k: CreateKind) => void; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label="What would you like to make?" className="grid grid-cols-1 gap-2.5 sm:grid-cols-3 sm:gap-4">
      {CREATE_KINDS.map((k) => {
        const on = value === k;
        return (
          <button
            key={k}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(k)}
            className={cn(
              "relative flex min-h-14 items-center gap-3 rounded-2xl border bg-surface px-4 text-left transition-[border-color,background-color,box-shadow] duration-150",
              "sm:min-h-[104px] sm:flex-col sm:justify-center sm:gap-2.5 sm:px-3 sm:text-center",
              "focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-60",
              on ? SELECTED : "border-line hover:border-line-strong hover:bg-mist/40",
            )}
          >
            <span className={cn("shrink-0 [&>svg]:size-6 [&>svg]:stroke-[1.6]", on ? "text-accent" : "text-ink")}>{KIND_ICON[k]}</span>
            <span className="text-body font-semibold text-ink sm:text-headline">{KIND_LABEL[k]}</span>
            {on ? (
              <span className="ml-auto flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-white sm:absolute sm:right-3 sm:top-3 sm:ml-0" aria-hidden>
                <Check className="size-3.5" strokeWidth={3} />
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** "Show a feature": the app's features (About your app) as chips. */
export function FeatureChips({ features, value, onPick }: { features: { id: string; name: string }[]; value: string | null; onPick: (id: string) => void }) {
  return (
    <ul aria-label="Your app’s features" className="-mx-4 flex snap-x gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 [&::-webkit-scrollbar]:hidden">
      {features.map((f) => {
        const on = value === f.id;
        return (
          <li key={f.id} className="shrink-0 snap-start">
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onPick(f.id)}
              className={cn(
                "inline-flex min-h-11 max-w-[16rem] items-center gap-1.5 rounded-full border px-4 text-body-sm font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus",
                on ? cn(SELECTED, "text-accent-ink") : "border-line-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink",
              )}
            >
              {on ? <Check className="size-3.5 shrink-0" strokeWidth={3} aria-hidden /> : null}
              <span className="truncate">{f.name}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** One line that grows with the text (⌘/Ctrl+Enter = Generate). */
export function PromptBox({ value, onChange, onSubmit, placeholder, invalid, describedBy, inputRef, label = "Describe your video" }: { value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string; invalid?: boolean; describedBy?: string; inputRef?: React.RefObject<HTMLTextAreaElement | null>; label?: string }) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const ref = inputRef ?? own;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [value, ref]);
  return (
    <div className={cn("rounded-2xl border bg-surface transition-[border-color,box-shadow] focus-within:border-accent focus-within:shadow-[0_0_0_3px_var(--ml-accent-soft)]", invalid ? "border-danger" : "border-line-strong")}>
      <label htmlFor="create-prompt" className="sr-only">
        {label}
      </label>
      <textarea
        id="create-prompt"
        ref={ref}
        rows={1}
        value={value}
        maxLength={MAX_PROMPT}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          // Generating spends credits, so it takes ⌘/Ctrl+Enter (or the button), never a stray Enter.
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        className="block max-h-60 min-h-[52px] w-full resize-none bg-transparent px-4 py-[15px] text-body leading-[22px] text-ink outline-none placeholder:text-ink-3"
      />
    </div>
  );
}

/** A native select (best on phones) that looks like the mockup's pill: icon, value, chevron. */
function PillSelect({ id, label, icon, value, onChange, options, className }: { id: string; label: string; icon: ReactNode; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; className?: string }) {
  return (
    <div className={cn("relative min-w-0", className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-2 sm:left-3.5 [&>svg]:size-[18px]" aria-hidden>
        {icon}
      </span>
      <select
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-11 w-full min-w-0 appearance-none truncate rounded-xl border border-line-strong bg-surface pl-9 pr-8 text-body-sm font-medium text-ink transition-colors hover:border-ink-3 focus-visible:border-accent focus-visible:outline-none focus-visible:shadow-focus sm:pl-10 sm:pr-9"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-ink-3 sm:right-3" aria-hidden />
    </div>
  );
}

/** Not a choice, just what it is ("YouTube · 16:9"): looks like the selects, without a chevron. */
function InfoPill({ icon, children, label, className }: { icon: ReactNode; children: ReactNode; label: string; className?: string }) {
  return (
    <p aria-label={label} className={cn("flex h-11 min-w-0 items-center gap-2.5 rounded-xl bg-mist px-3 text-body-sm font-medium text-ink sm:px-3.5", className)}>
      <span className="shrink-0 text-ink-2 [&>svg]:size-[18px]" aria-hidden>
        {icon}
      </span>
      <span className="truncate">{children}</span>
    </p>
  );
}

export function FormatSelect({ value, onChange }: { value: FormatId; onChange: (v: FormatId) => void }) {
  return <PillSelect id="create-format" label="Format" icon={<Smartphone />} value={value} onChange={(v) => onChange(v as FormatId)} options={FORMATS.map((f) => ({ value: f.id, label: f.label }))} className="sm:w-48" />;
}

export function LengthSelect({ value, options, onChange }: { value: number; options: number[]; onChange: (v: number) => void }) {
  return <PillSelect id="create-length" label="Length" icon={<Clock />} value={String(value)} onChange={(v) => onChange(Number(v))} options={options.map((s) => ({ value: String(s), label: `${s} seconds` }))} className="sm:w-40" />;
}

const MAKE_ICON: Record<MakeFormat, ReactNode> = {
  video: <Clapperboard aria-hidden />,
  post: <ImageIcon aria-hidden />,
  carousel: <GalleryHorizontalEnd aria-hidden />,
  thumbnail: <RectangleHorizontal aria-hidden />,
  store_screenshots: <Smartphone aria-hidden />,
  text_post: <Type aria-hidden />,
};
const MAIN_LABEL: Record<(typeof MAIN_MAKES)[number], string> = { video: "Video", post: "Post", carousel: "Carousel" };
/** The More segment once one of its formats is picked (short, so it fits on a phone). */
const MORE_SHORT: Partial<Record<MakeFormat, string>> = { thumbnail: "Thumbnail", store_screenshots: "Screenshots", text_post: "Text post" };

/**
 * "Make a…": Video · Post · Carousel · More (Thumbnail, App Store screenshots, Google Play
 * screenshots, Text post). One row of segments, like the Apple segmented control; More opens a menu
 * and then shows what was picked from it.
 */
export function MakeChoice({ value, store, onChange, disabled }: { value: MakeFormat; store: StoreTarget | null; onChange: (make: MakeFormat, store?: StoreTarget) => void; disabled?: boolean }) {
  const inMore = !(MAIN_MAKES as readonly string[]).includes(value);
  const seg = (on: boolean) =>
    cn(
      "relative inline-flex h-10 min-w-0 flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-body-sm font-medium transition-[background-color,color,box-shadow] duration-200 sm:flex-none sm:px-4",
      "focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
      on ? "bg-surface text-ink shadow-[0_1px_3px_rgb(16_24_40/0.12),0_0_0_0.5px_rgb(16_24_40/0.06)]" : "text-ink-2 hover:text-ink",
    );
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-3">
      <span id="create-make-label" className="text-footnote font-medium text-ink-2">
        Make a
      </span>
      <div role="group" aria-labelledby="create-make-label" className="flex w-full min-w-0 items-center gap-0.5 rounded-full bg-mist p-[3px] sm:inline-flex sm:w-auto">
        {MAIN_MAKES.map((m) => (
          <button key={m} type="button" aria-pressed={value === m} disabled={disabled} onClick={() => onChange(m)} className={seg(value === m)}>
            <span className="hidden sm:contents">{MAKE_ICON[m]}</span>
            {MAIN_LABEL[m]}
          </button>
        ))}
        <Menu>
          <MenuTrigger asChild>
            <button type="button" aria-pressed={inMore} disabled={disabled} aria-label={inMore ? `More formats: ${MORE_SHORT[value] ?? "More"}` : "More formats"} className={seg(inMore)}>
              {inMore ? <span className="hidden sm:contents">{MAKE_ICON[value]}</span> : null}
              {inMore ? MORE_SHORT[value] : "More"}
              <ChevronDown className="!size-3.5 text-ink-3" aria-hidden />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="w-72">
            <MenuLabel>More to make</MenuLabel>
            {MORE_MAKES.map((m) => {
              const on = value === m.make && (m.make !== "store_screenshots" || (store ?? "ios") === m.store);
              return (
                <MenuItem key={`${m.make}:${m.store ?? ""}`} icon={MAKE_ICON[m.make]} trailing={on ? <Check className="size-4 text-accent" aria-label="Chosen" /> : m.hint} onSelect={() => onChange(m.make, m.store)}>
                  {m.label}
                </MenuItem>
              );
            })}
          </MenuContent>
        </Menu>
      </div>
    </div>
  );
}

export function WhereSelect({ value, options, onChange, className }: { value: Channel; options: readonly Channel[]; onChange: (c: Channel) => void; className?: string }) {
  return <PillSelect id="create-where" label="Where it goes" icon={<ChannelMark channel={value} size={18} />} value={value} onChange={(v) => onChange(v as Channel)} options={options.map((c) => ({ value: c, label: CHANNEL_LABEL[c] }))} className={cn("sm:w-44", className)} />;
}

export function ShapeSelect({ value, onChange, className }: { value: Shape; onChange: (s: Shape) => void; className?: string }) {
  return <PillSelect id="create-shape" label="Shape" icon={value === "1:1" ? <Square /> : <RectangleVertical />} value={value} onChange={(v) => onChange(v as Shape)} options={SHAPES} className={cn("sm:w-44", className)} />;
}

export function SlidesSelect({ value, options, onChange, className }: { value: number; options: number[]; onChange: (n: number) => void; className?: string }) {
  return <PillSelect id="create-slides" label="Slides" icon={<Layers />} value={String(value)} onChange={(v) => onChange(Number(v))} options={options.map((n) => ({ value: String(n), label: `${n} slides` }))} className={cn("sm:w-36", className)} />;
}

export function StoreSelect({ value, onChange, className }: { value: StoreTarget; onChange: (s: StoreTarget) => void; className?: string }) {
  return (
    <PillSelect
      id="create-store"
      label="Store"
      icon={<Smartphone />}
      value={value}
      onChange={(v) => onChange(v as StoreTarget)}
      options={[
        { value: "ios", label: "App Store" },
        { value: "android", label: "Google Play" },
      ]}
      className={cn("sm:w-44", className)}
    />
  );
}

export function ThumbnailInfo({ className }: { className?: string }) {
  return (
    <InfoPill label="YouTube thumbnail, 16:9" icon={<ChannelMark channel="youtube" size={18} />} className={cn("sm:w-48", className)}>
      YouTube · 16:9
    </InfoPill>
  );
}

/** "Generate carousel | 18 credits": the credits are the real estimate, never a placeholder. */
export function GenerateButton({ label = "Generate video", credits, loading, disabled, onClick, className }: { label?: string; credits: number | null; loading?: boolean; disabled?: boolean; onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        "inline-flex h-11 shrink-0 items-center justify-center rounded-xl bg-accent px-5 text-body font-semibold text-white transition-[background-color,opacity] hover:bg-accent-hover active:bg-accent-ink",
        "focus-visible:outline-none focus-visible:shadow-focus disabled:cursor-not-allowed disabled:bg-accent/45",
        className,
      )}
    >
      {loading ? <Spinner size={16} className="mr-2 text-current" /> : null}
      {label}
      {credits !== null ? (
        <>
          <span className="mx-3 h-5 w-px bg-white/35" aria-hidden />
          <span className="text-footnote font-medium tabular text-white/90">
            {credits.toLocaleString()} credit{credits === 1 ? "" : "s"}
          </span>
        </>
      ) : null}
    </button>
  );
}

/** "Up to 44 credits of your 1,960 · What it costs": the estimate lines, before anything runs. */
export function CostLine({ lines, total, available, loading, what = "video", note }: { lines: { label: string; credits: number }[]; total: number | null; available: number | null; loading: boolean; what?: string; note?: string }) {
  if (loading && total === null) return <p className="text-footnote text-ink-3">Working out the cost…</p>;
  if (total === null) return <p className="text-footnote text-ink-3">The cost estimate isn’t available right now.</p>;
  const short = available !== null && total > available;
  return (
    <div className="flex flex-wrap items-center gap-x-1.5 text-footnote text-ink-2">
      <span className={cn(short && "font-medium text-danger")}>
        {short ? `Needs up to ${total.toLocaleString()} credits; you have ${available!.toLocaleString()}.` : `Up to ${total.toLocaleString()} credits${available !== null ? ` of your ${available.toLocaleString()}` : ""}.`}
      </span>
      <Popover
        label="What it costs"
        align="start"
        className="w-80 p-4"
        trigger={
          <button type="button" className="inline-flex min-h-11 items-center font-medium text-accent hover:underline sm:min-h-0">
            What it costs
          </button>
        }
      >
        <p className="mb-2 text-footnote font-semibold text-ink">One {what}, start to finish</p>
        <ul className="space-y-1.5">
          {lines.map((l) => (
            <li key={l.label} className="flex justify-between gap-3 text-footnote">
              <span className="text-ink-2">{l.label}</span>
              <span className="tabular text-ink">{l.credits}</span>
            </li>
          ))}
          <li className="flex justify-between gap-3 border-t border-line pt-1.5 text-footnote font-medium">
            <span>Up to</span>
            <span className="tabular">{total}</span>
          </li>
        </ul>
        <p className="mt-3 text-caption text-ink-3 text-pretty">{note ?? "Credits are held when a step starts and only what’s used is charged. The preview and the brand check are free. Stock clips Muse adds cost 1 credit each. If the video comes out longer, Muse asks before finishing it."}</p>
      </Popover>
    </div>
  );
}
