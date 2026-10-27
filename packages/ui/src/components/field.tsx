"use client";
import { Check, ChevronDown } from "lucide-react";
import { Checkbox as CheckboxPrimitive, Switch as SwitchPrimitive } from "radix-ui";
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { cn } from "../cn";

const CONTROL =
  "w-full rounded-md border border-line-strong bg-surface px-3 text-body-sm text-ink placeholder:text-ink-3 " +
  "transition-[border-color,box-shadow] duration-150 ease-out " +
  "hover:border-ink-3 focus:border-accent focus:outline-none focus:shadow-focus " +
  "disabled:bg-mist disabled:text-ink-3 aria-[invalid=true]:border-danger";

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  optional?: boolean;
  className?: string;
  children: (ids: { id: string; describedBy?: string; invalid: boolean }) => ReactNode;
}

/** Label + control + hint/error, with ids wired for screen readers. */
export function Field({ label, hint, error, optional, className, children }: FieldProps) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  const describedBy = [hint && !error ? hintId : null, error ? errId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <label htmlFor={id} className="flex items-baseline justify-between gap-2 text-footnote font-medium text-ink">
          <span>{label}</span>
          {optional ? <span className="font-normal text-ink-3">Optional</span> : null}
        </label>
      ) : null}
      {children({ id, describedBy, invalid: Boolean(error) })}
      {error ? (
        <p id={errId} className="text-footnote text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={hintId} className="text-footnote text-ink-2">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  inputSize?: "md" | "lg";
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ className, invalid, leading, trailing, inputSize = "md", ...rest }, ref) {
  const input = (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cn(CONTROL, inputSize === "lg" ? "h-11 text-body" : "h-9", leading ? "pl-9" : null, trailing ? "pr-9" : null, className)}
      {...rest}
    />
  );
  if (!leading && !trailing) return input;
  return (
    <div className="relative">
      {leading ? <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 [&_svg]:size-4">{leading}</span> : null}
      {input}
      {trailing ? <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 [&_svg]:size-4">{trailing}</span> : null}
    </div>
  );
});

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea({ className, invalid, rows = 4, ...rest }, ref) {
  return <textarea ref={ref} rows={rows} aria-invalid={invalid || undefined} className={cn(CONTROL, "min-h-20 resize-y py-2 leading-[20px]", className)} {...rest} />;
});

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> {
  options: SelectOption[];
  placeholder?: string;
  invalid?: boolean;
  selectSize?: "sm" | "md" | "lg";
}

/** Native select (best mobile + a11y behaviour), styled to match. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select({ options, placeholder, invalid, className, selectSize = "md", ...rest }, ref) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(CONTROL, "appearance-none pr-9", selectSize === "lg" ? "h-11 text-body" : selectSize === "sm" ? "h-8 text-footnote" : "h-9", className)}
        {...rest}
      >
        {placeholder ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
      <ChevronDown aria-hidden className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-ink-3" />
    </div>
  );
});

export interface SwitchProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}

export function Switch({ checked, onCheckedChange, disabled, label, id }: SwitchProps) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className={cn(
        "relative inline-flex h-[26px] w-[44px] shrink-0 items-center rounded-full transition-colors duration-200 ease-out",
        "focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50",
        checked ? "bg-success" : "bg-mist-2",
      )}
    >
      <SwitchPrimitive.Thumb className="block size-[22px] translate-x-[2px] rounded-full bg-white shadow-[0_2px_4px_rgb(0_0_0/0.15),0_0_0_0.5px_rgb(0_0_0/0.04)] transition-transform duration-200 ease-out data-[state=checked]:translate-x-[20px]" />
    </SwitchPrimitive.Root>
  );
}

export interface CheckboxProps {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label: ReactNode;
  description?: ReactNode;
  className?: string;
}

export function Checkbox({ checked, onCheckedChange, disabled, label, description, className }: CheckboxProps) {
  const id = useId();
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <CheckboxPrimitive.Root
        id={id}
        checked={checked}
        onCheckedChange={(v) => onCheckedChange(v === true)}
        disabled={disabled}
        className={cn(
          "mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border transition-colors duration-150",
          "focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50",
          checked ? "border-accent bg-accent text-white" : "border-line-strong bg-surface hover:border-ink-3",
        )}
      >
        <CheckboxPrimitive.Indicator>
          <Check className="size-3.5" strokeWidth={3} aria-hidden />
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Root>
      <label htmlFor={id} className="min-w-0 cursor-pointer select-none space-y-0.5">
        <span className="block text-body-sm text-ink">{label}</span>
        {description ? <span className="block text-footnote text-ink-2">{description}</span> : null}
      </label>
    </div>
  );
}

/** Pill-style multi/single choice chips (channels, goals, deliverables). */
export function ChoiceChips<T extends string>({
  options,
  value,
  onChange,
  multiple = false,
  label,
  className,
}: {
  options: { value: T; label: string; icon?: ReactNode; disabled?: boolean }[];
  value: T[];
  onChange: (v: T[]) => void;
  multiple?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap gap-2", className)}>
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={o.disabled}
            onClick={() => onChange(multiple ? (on ? value.filter((v) => v !== o.value) : [...value, o.value]) : [o.value])}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-footnote font-medium transition-colors duration-150",
              "focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40 [&_svg]:size-3.5",
              on ? "border-accent bg-accent-soft text-accent-ink" : "border-line-strong bg-surface text-ink-2 hover:border-ink-3 hover:text-ink",
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
