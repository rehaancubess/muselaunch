"use client";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cn } from "../cn";

export type ToastTone = "neutral" | "success" | "danger";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: ToastTone;
  action?: { label: string; onClick: () => void };
  /** ms; 0 = sticky. Default 5000 (errors 8000). */
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  toast: (t: ToastInput) => number;
  success: (title: string, description?: string) => number;
  error: (title: string, description?: string, action?: ToastInput["action"]) => number;
  dismiss: (id: number) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const toast = useCallback(
    (t: ToastInput) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { ...t, id }]);
      const ms = t.duration ?? (t.tone === "danger" ? 8000 : 5000);
      if (ms > 0) setTimeout(() => dismiss(id), ms);
      return id;
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      toast,
      dismiss,
      success: (title, description) => toast({ title, description, tone: "success" }),
      error: (title, description, action) => toast({ title, description, tone: "danger", action }),
    }),
    [toast, dismiss],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div aria-live="polite" aria-relevant="additions" className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-2 px-4 sm:bottom-6 sm:items-end sm:px-6">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "danger" ? "alert" : "status"}
            className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl bg-surface px-4 py-3 shadow-float animate-rise-in"
          >
            <span className={cn("mt-0.5 shrink-0", t.tone === "success" ? "text-success" : t.tone === "danger" ? "text-danger" : "text-ink-2")}>
              {t.tone === "success" ? <CheckCircle2 className="size-4" aria-hidden /> : t.tone === "danger" ? <AlertCircle className="size-4" aria-hidden /> : <Info className="size-4" aria-hidden />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-body-sm font-medium text-ink">{t.title}</p>
              {t.description ? <p className="mt-0.5 text-footnote text-ink-2 text-pretty">{t.description}</p> : null}
              {t.action ? (
                <button
                  type="button"
                  className="mt-1.5 text-footnote font-medium text-accent hover:underline"
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              ) : null}
            </div>
            <button type="button" onClick={() => dismiss(t.id)} aria-label="Dismiss" className="-mr-1 shrink-0 rounded-full p-1 text-ink-3 hover:bg-mist hover:text-ink">
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
