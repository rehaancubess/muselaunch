"use client";
import { Slot } from "radix-ui";
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../cn";
import { Spinner } from "./feedback";

export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger" | "ink" | "link";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover active:bg-accent-ink disabled:bg-accent/45",
  secondary: "bg-mist text-ink hover:bg-mist-2 active:bg-line disabled:text-ink-3",
  outline: "bg-surface text-ink border border-line-strong hover:bg-mist active:bg-mist-2 disabled:text-ink-3",
  ghost: "text-ink-2 hover:bg-mist hover:text-ink active:bg-mist-2 disabled:text-ink-3",
  danger: "bg-danger text-white hover:brightness-95 active:brightness-90 disabled:opacity-50",
  ink: "bg-ink text-white hover:bg-ink/88 active:bg-ink/80 disabled:opacity-50",
  link: "text-accent hover:text-accent-hover underline-offset-4 hover:underline px-0 h-auto",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 px-3 text-footnote gap-1.5",
  md: "h-9 px-4 text-body-sm gap-2",
  lg: "h-11 px-5 text-body gap-2",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Icon rendered before the label. */
  icon?: ReactNode;
  /** Icon rendered after the label. */
  trailing?: ReactNode;
  /** Render the child element (e.g. a Next.js <Link>) with button styling. */
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading = false, icon, trailing, asChild, className, children, disabled, type, ...rest },
  ref,
) {
  const cls = cn(
    "inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-full font-medium",
    "transition-[background-color,color,box-shadow,filter,opacity] duration-150 ease-out",
    "focus-visible:outline-none focus-visible:shadow-focus",
    VARIANT[variant],
    variant !== "link" && SIZE[size],
    className,
  );
  if (asChild) {
    return (
      <Slot.Root ref={ref} className={cls} {...rest}>
        {children}
      </Slot.Root>
    );
  }
  return (
    <button ref={ref} type={type ?? "button"} className={cls} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <Spinner size={size === "lg" ? 16 : 14} className="text-current" /> : icon}
      {children}
      {trailing}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Accessible name (required: icon buttons have no visible text). */
  label: string;
  size?: "sm" | "md" | "lg";
  variant?: "ghost" | "secondary" | "outline";
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = "md", variant = "ghost", active, className, children, type, ...rest },
  ref,
) {
  const dims = size === "sm" ? "size-7" : size === "lg" ? "size-10" : "size-8";
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-ink-2 transition-colors duration-150",
        "focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-40",
        variant === "ghost" && "hover:bg-mist hover:text-ink",
        variant === "secondary" && "bg-mist hover:bg-mist-2 text-ink",
        variant === "outline" && "border border-line-strong bg-surface hover:bg-mist text-ink",
        active && "bg-mist text-ink",
        dims,
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
