"use client";
import { Tabs as TabsPrimitive } from "radix-ui";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn";

export interface SegmentedItem<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
  /** Render as a link (e.g. primary navigation). */
  href?: string;
  disabled?: boolean;
}

export interface SegmentedControlProps<T extends string> {
  items: SegmentedItem<T>[];
  value: T;
  onChange?: (v: T) => void;
  label: string;
  size?: "sm" | "md" | "lg";
  className?: string;
  /** Custom link renderer (e.g. Next.js Link) for items with `href`. */
  renderLink?: (props: { href: string; className: string; children: ReactNode; "aria-current"?: "page"; onClick?: () => void }) => ReactNode;
  fullWidth?: boolean;
}

/**
 * Apple-style segmented control with a sliding thumb. Used for the three primary tabs
 * (as links) and for in-page view switches (as buttons).
 */
export function SegmentedControl<T extends string>({ items, value, onChange, label, size = "md", className, renderLink, fullWidth }: SegmentedControlProps<T>) {
  const wrap = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current?.querySelector<HTMLElement>(`[data-seg="${CSS.escape(value)}"]`);
    if (!el || !wrap.current) return setThumb(null);
    const measure = () => setThumb({ left: el.offsetLeft, width: el.offsetWidth });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [value, items.length]);

  const h = size === "sm" ? "h-7 text-footnote" : size === "lg" ? "h-9 text-body-sm" : "h-8 text-footnote";
  const isNav = items.some((i) => i.href);

  return (
    <div
      ref={wrap}
      role={isNav ? undefined : "radiogroup"}
      aria-label={label}
      className={cn("relative inline-flex items-center rounded-full bg-mist p-[3px]", fullWidth && "flex w-full", className)}
    >
      {thumb ? (
        <span
          aria-hidden
          className="absolute top-[3px] bottom-[3px] rounded-full bg-surface shadow-[0_1px_3px_rgb(16_24_40/0.12),0_0_0_0.5px_rgb(16_24_40/0.06)] transition-[left,width] duration-300 ease-out"
          style={{ left: thumb.left, width: thumb.width }}
        />
      ) : null}
      {items.map((item) => {
        const active = item.value === value;
        const cls = cn(
          "relative z-[1] inline-flex items-center justify-center gap-1.5 rounded-full px-3.5 font-medium transition-colors duration-200",
          "focus-visible:outline-none focus-visible:shadow-focus [&_svg]:size-3.5",
          h,
          fullWidth && "flex-1",
          active ? "text-ink" : "text-ink-2 hover:text-ink",
          item.disabled && "pointer-events-none opacity-40",
        );
        const content = (
          <>
            {item.icon}
            {item.label}
          </>
        );
        if (item.href) {
          const props = { href: item.href, className: cls, children: content, "aria-current": active ? ("page" as const) : undefined, onClick: () => onChange?.(item.value) };
          return (
            <span key={item.value} data-seg={item.value} className={cn("relative z-[1] inline-flex", fullWidth && "flex-1")}>
              {renderLink ? renderLink(props) : <a {...props} />}
            </span>
          );
        }
        return (
          <button
            key={item.value}
            data-seg={item.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={item.disabled}
            onClick={() => onChange?.(item.value)}
            className={cls}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- Underline tabs (in-page sections)

export const Tabs = TabsPrimitive.Root;

export function TabsList({ children, className, label }: { children: ReactNode; className?: string; label?: string }) {
  return (
    <TabsPrimitive.List aria-label={label} className={cn("flex items-center gap-6 border-b border-line", className)}>
      {children}
    </TabsPrimitive.List>
  );
}

export function TabsTrigger({ value, children, className, count }: { value: string; children: ReactNode; className?: string; count?: number }) {
  return (
    <TabsPrimitive.Trigger
      value={value}
      className={cn(
        "relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 border-transparent text-body-sm font-medium text-ink-2 transition-colors",
        "hover:text-ink focus-visible:outline-none data-[state=active]:border-ink data-[state=active]:text-ink",
        className,
      )}
    >
      {children}
      {count != null ? <span className="rounded-full bg-mist px-1.5 text-caption tabular text-ink-2">{count}</span> : null}
    </TabsPrimitive.Trigger>
  );
}

export function TabsContent({ value, children, className }: { value: string; children: ReactNode; className?: string }) {
  return (
    <TabsPrimitive.Content value={value} className={cn("pt-6 focus-visible:outline-none data-[state=active]:animate-fade-in", className)}>
      {children}
    </TabsPrimitive.Content>
  );
}
