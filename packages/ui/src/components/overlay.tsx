"use client";
import { X } from "lucide-react";
import { Dialog as D, DropdownMenu as M, Popover as P, Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";
import { cn } from "../cn";

// ---------------------------------------------------------------- Dialog

export interface DialogProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Hide the visible title (still announced to screen readers). */
  hideTitle?: boolean;
  className?: string;
}

const DIALOG_W = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" } as const;

export function Dialog({ open, onOpenChange, trigger, title, description, children, footer, size = "md", hideTitle, className }: DialogProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[rgb(29_29_31/0.28)] backdrop-blur-[2px] data-[state=open]:animate-fade-in" />
        <D.Content
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-32px)] w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "rounded-2xl bg-surface shadow-float focus:outline-none data-[state=open]:animate-scale-in",
            DIALOG_W[size],
            className,
          )}
        >
          <div className={cn("flex items-start gap-4 px-6 pt-6", hideTitle && "sr-only")}>
            <div className="min-w-0 flex-1 space-y-1">
              <D.Title className="text-title-3 font-semibold">{title}</D.Title>
              {description ? <D.Description className="text-body-sm text-ink-2 text-pretty">{description}</D.Description> : null}
            </div>
            <D.Close className="-mr-2 -mt-1 inline-flex size-8 items-center justify-center rounded-full text-ink-2 hover:bg-mist hover:text-ink" aria-label="Close">
              <X className="size-4" aria-hidden />
            </D.Close>
          </div>
          {!description && hideTitle ? <D.Description className="sr-only">Dialog</D.Description> : null}
          {children ? <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div> : <div className="h-5" />}
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line px-6 py-4">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ---------------------------------------------------------------- Sheet (side panel / mobile bottom sheet)

export interface SheetProps {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  side?: "right" | "bottom";
  children?: ReactNode;
  footer?: ReactNode;
  width?: string;
}

export function Sheet({ open, onOpenChange, trigger, title, description, side = "right", children, footer, width = "max-w-md" }: SheetProps) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      {trigger ? <D.Trigger asChild>{trigger}</D.Trigger> : null}
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-[rgb(29_29_31/0.2)] data-[state=open]:animate-fade-in" />
        <D.Content
          className={cn(
            "fixed z-50 flex flex-col bg-surface shadow-float focus:outline-none",
            side === "right" && cn("inset-y-2 right-2 w-[calc(100vw-16px)] rounded-2xl data-[state=open]:animate-[ml-sheet-in-right_260ms_var(--ml-ease)]", width),
            side === "bottom" && "inset-x-0 bottom-0 max-h-[88dvh] rounded-t-2xl data-[state=open]:animate-[ml-sheet-in-bottom_280ms_var(--ml-ease)]",
          )}
        >
          <style>{`@keyframes ml-sheet-in-right{from{transform:translateX(24px);opacity:0}to{transform:none;opacity:1}}@keyframes ml-sheet-in-bottom{from{transform:translateY(32px);opacity:0}to{transform:none;opacity:1}}`}</style>
          <div className="flex items-start gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1 space-y-0.5">
              <D.Title className="text-headline font-semibold">{title}</D.Title>
              {description ? <D.Description className="text-footnote text-ink-2">{description}</D.Description> : <D.Description className="sr-only">Panel</D.Description>}
            </div>
            <D.Close className="-mr-1.5 inline-flex size-8 items-center justify-center rounded-full text-ink-2 hover:bg-mist hover:text-ink" aria-label="Close">
              <X className="size-4" aria-hidden />
            </D.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer ? <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ---------------------------------------------------------------- Popover

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  align?: "start" | "center" | "end";
  side?: "top" | "right" | "bottom" | "left";
  className?: string;
  label?: string;
}

export function Popover({ trigger, children, open, onOpenChange, align = "center", side = "bottom", className, label }: PopoverProps) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content
          align={align}
          side={side}
          sideOffset={8}
          collisionPadding={12}
          aria-label={label}
          className={cn("z-50 w-80 rounded-xl bg-surface p-4 shadow-float focus:outline-none data-[state=open]:animate-scale-in", className)}
        >
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

// ---------------------------------------------------------------- Tooltip

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <T.Provider delayDuration={350}>{children}</T.Provider>;
}

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "right" | "bottom" | "left" }) {
  return (
    <T.Root>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} collisionPadding={8} className="z-[60] max-w-xs rounded-md bg-ink px-2.5 py-1.5 text-footnote text-white shadow-float data-[state=delayed-open]:animate-fade-in">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}

// ---------------------------------------------------------------- Menu (dropdown)

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ children, align = "start", className, sideOffset = 8 }: { children: ReactNode; align?: "start" | "center" | "end"; className?: string; sideOffset?: number }) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={sideOffset} collisionPadding={12} className={cn("z-50 min-w-56 rounded-xl bg-surface p-1.5 shadow-float focus:outline-none data-[state=open]:animate-scale-in", className)}>
        {children}
      </M.Content>
    </M.Portal>
  );
}

export function MenuItem({ children, icon, trailing, onSelect, destructive, disabled, className }: { children: ReactNode; icon?: ReactNode; trailing?: ReactNode; onSelect?: (e: Event) => void; destructive?: boolean; disabled?: boolean; className?: string }) {
  return (
    <M.Item
      onSelect={onSelect}
      disabled={disabled}
      className={cn(
        "flex h-9 cursor-default select-none items-center gap-2.5 rounded-md px-2.5 text-body-sm outline-none",
        "data-[highlighted]:bg-mist data-[disabled]:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0",
        destructive ? "text-danger" : "text-ink",
        className,
      )}
    >
      {icon ? <span className={cn("flex", destructive ? "text-danger" : "text-ink-2")}>{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {trailing ? <span className="text-footnote text-ink-3">{trailing}</span> : null}
    </M.Item>
  );
}

export function MenuLink({ children, icon, href, trailing, active, onNavigate }: { children: ReactNode; icon?: ReactNode; href: string; trailing?: ReactNode; active?: boolean; onNavigate?: (href: string) => void }) {
  return (
    <M.Item
      asChild
      onSelect={(e) => {
        if (onNavigate) {
          e.preventDefault();
          onNavigate(href);
        }
      }}
    >
      <a
        href={href}
        className={cn(
          "flex h-9 select-none items-center gap-2.5 rounded-md px-2.5 text-body-sm text-ink outline-none data-[highlighted]:bg-mist [&_svg]:size-4 [&_svg]:shrink-0",
          active && "font-medium",
        )}
      >
        {icon ? <span className="flex text-ink-2">{icon}</span> : null}
        <span className="min-w-0 flex-1 truncate">{children}</span>
        {trailing ? <span className="text-footnote text-ink-3">{trailing}</span> : null}
      </a>
    </M.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="px-2.5 pb-1 pt-2 text-caption font-medium text-ink-3">{children}</M.Label>;
}

export function MenuSeparator() {
  return <M.Separator className="-mx-1.5 my-1.5 h-px bg-line" />;
}
