"use client";
/**
 * Create's form pieces: the three big choices, the feature chips, the one-line prompt that grows,
 * the Format / Length selects and the "Generate video | N credits" button (the real estimate).
 */
import { Popover, Spinner, cn } from "@muselaunch/ui";
import { Check, ChevronDown, Clock, Megaphone, Smartphone, Sparkle, SquarePlay } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { CREATE_KINDS, FORMATS, KIND_LABEL, MAX_PROMPT, type CreateKind, type FormatId } from "./plan";

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
export function PromptBox({ value, onChange, onSubmit, placeholder, invalid, describedBy, inputRef }: { value: string; onChange: (v: string) => void; onSubmit: () => void; placeholder: string; invalid?: boolean; describedBy?: string; inputRef?: React.RefObject<HTMLTextAreaElement | null> }) {
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
        Describe your video
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

export function FormatSelect({ value, onChange }: { value: FormatId; onChange: (v: FormatId) => void }) {
  return <PillSelect id="create-format" label="Format" icon={<Smartphone />} value={value} onChange={(v) => onChange(v as FormatId)} options={FORMATS.map((f) => ({ value: f.id, label: f.label }))} className="sm:w-48" />;
}

export function LengthSelect({ value, options, onChange }: { value: number; options: number[]; onChange: (v: number) => void }) {
  return <PillSelect id="create-length" label="Length" icon={<Clock />} value={String(value)} onChange={(v) => onChange(Number(v))} options={options.map((s) => ({ value: String(s), label: `${s} seconds` }))} className="sm:w-40" />;
}

/** "Generate video | 44 credits": the credits are the real estimate, never a placeholder. */
export function GenerateButton({ credits, loading, disabled, onClick, className }: { credits: number | null; loading?: boolean; disabled?: boolean; onClick: () => void; className?: string }) {
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
      Generate video
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
export function CostLine({ lines, total, available, loading }: { lines: { label: string; credits: number }[]; total: number | null; available: number | null; loading: boolean }) {
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
        <p className="mb-2 text-footnote font-semibold text-ink">One video, start to finish</p>
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
        <p className="mt-3 text-caption text-ink-3 text-pretty">Credits are held when a step starts and only what’s used is charged. The preview and the brand check are free. Stock clips Muse adds cost 1 credit each. If the video comes out longer, Muse asks before finishing it.</p>
      </Popover>
    </div>
  );
}
