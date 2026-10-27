"use client";
import { X } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";
import { cn } from "../cn";

export interface TagInputProps {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  label: string;
  max?: number;
  maxLength?: number;
  disabled?: boolean;
  tone?: "neutral" | "danger";
  className?: string;
  id?: string;
}

/** Editable list of short phrases (tone words, CTAs, banned phrases). Enter or comma adds. */
export function TagInput({ value, onChange, placeholder = "Add and press Enter", label, max = 50, maxLength = 120, disabled, tone = "neutral", className, id }: TagInputProps) {
  const [draft, setDraft] = useState("");
  const autoId = useId();
  const inputId = id ?? autoId;
  const add = (raw: string) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim().slice(0, maxLength))
      .filter(Boolean);
    if (!parts.length) return;
    const next = [...value];
    for (const p of parts) if (!next.some((x) => x.toLowerCase() === p.toLowerCase()) && next.length < max) next.push(p);
    onChange(next);
    setDraft("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add(draft);
    } else if (e.key === "Backspace" && !draft && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  return (
    <div
      className={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-md border border-line-strong bg-surface px-1.5 py-1.5 transition-[border-color,box-shadow]",
        "focus-within:border-accent focus-within:shadow-focus",
        disabled && "bg-mist",
        className,
      )}
    >
      {value.map((t) => (
        <span key={t} className={cn("inline-flex h-6 items-center gap-1 rounded-full pl-2.5 pr-1 text-footnote", tone === "danger" ? "bg-danger-soft text-danger" : "bg-mist text-ink")}>
          {t}
          {!disabled ? (
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))} className="inline-flex size-4 items-center justify-center rounded-full text-ink-3 hover:bg-black/5 hover:text-ink">
              <X className="size-3" aria-hidden />
            </button>
          ) : null}
        </span>
      ))}
      <input
        id={inputId}
        aria-label={label}
        value={draft}
        disabled={disabled || value.length >= max}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => draft.trim() && add(draft)}
        placeholder={value.length ? "" : placeholder}
        className="h-6 min-w-[5rem] flex-1 bg-transparent px-1.5 text-body-sm text-ink outline-none placeholder:text-ink-3"
      />
    </div>
  );
}
