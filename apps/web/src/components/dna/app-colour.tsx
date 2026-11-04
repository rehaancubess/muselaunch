"use client";
import { isThemeable, normalizeHex, pickThemeColor, type BrandProfile } from "@muselaunch/contracts";
import { cn, useToast } from "@muselaunch/ui";
import { Check, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { applyAppTheme } from "@/lib/app-theme";
import { useInvalidate } from "@/lib/query";
import { useCurrentApp } from "@/lib/workspace";

type Choice = { key: string; label: string; color: string | null; body: { color: string | null } | "icon" };

/**
 * The colour MuseLaunch takes while you work on this app. Defaults to the app icon's colour (App DNA);
 * the person can pick another palette colour, any colour, or monochrome. Saved straight away.
 */
export function AppColourPicker({ palette, canEdit }: { palette: BrandProfile["visual"]["palette"]; canEdit: boolean }) {
  const { app, appId, workspaceId } = useCurrentApp();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const iconColor = pickThemeColor(palette);
  const current = app?.theme?.color ?? null;
  const isIcon = !app?.theme || app.theme.source === "icon";

  // The colour previews at once; saving is debounced and always saves the latest pick (dragging the
  // colour picker fires a change per mouse move), one request at a time.
  const latest = useRef<Choice | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flush = async () => {
    if (inFlight.current || !latest.current) return;
    const c = latest.current;
    latest.current = null;
    inFlight.current = true;
    try {
      await api.patch(wsPath(workspaceId, `/apps/${appId}`), { theme: c.body });
      await invalidate(wsPath(workspaceId, "/apps"));
    } catch (e) {
      if (!latest.current) applyAppTheme(current);
      toast.error("Couldn’t change the colour", errorMessage(e));
    } finally {
      inFlight.current = false;
      if (latest.current) void flush();
      else setPendingKey(null);
    }
  };
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current);
        void flushRef.current();
      }
    },
    [],
  );
  const choose = (c: Choice, delayMs = 0) => {
    if (!canEdit) return;
    applyAppTheme(c.color);
    setPendingKey(c.key);
    latest.current = c;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void flushRef.current();
    }, delayMs);
  };

  const seen = new Set<string>();
  const choices: Choice[] = [];
  if (iconColor) {
    seen.add(iconColor);
    choices.push({ key: "icon", label: "Your icon’s colour", color: iconColor, body: "icon" });
  }
  for (const p of palette) {
    const hex = normalizeHex(p.hex);
    if (!hex || seen.has(hex) || !isThemeable(hex)) continue;
    seen.add(hex);
    choices.push({ key: hex, label: `${p.role[0]!.toUpperCase()}${p.role.slice(1)} colour ${hex.toUpperCase()}`, color: hex, body: { color: hex } });
  }
  choices.push({ key: "mono", label: "Monochrome", color: null, body: { color: null } });
  const savedKey = isIcon && iconColor && current === iconColor ? "icon" : current ? (seen.has(current) ? current : "custom") : "mono";
  const selectedKey = pendingKey ?? savedKey;
  const shown = latest.current?.color ?? current;

  return (
    <div className="space-y-3">
      <div role="radiogroup" aria-label="App colour" className="flex flex-wrap items-center gap-2.5">
        {choices.map((c) => {
          const on = selectedKey === c.key;
          return (
            <button
              key={c.key}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={c.label}
              title={c.label}
              disabled={!canEdit}
              onClick={() => choose(c)}
              className={cn(
                "relative grid size-9 place-items-center rounded-full shadow-[inset_0_0_0_1px_rgb(0_0_0/0.12)] outline-none transition-transform focus-visible:shadow-focus enabled:hover:scale-105 disabled:cursor-default",
                on && "ring-2 ring-ink ring-offset-2 ring-offset-surface",
              )}
              style={{ background: c.color ?? "linear-gradient(135deg, #f5f5f7 0 50%, #1d1d1f 50% 100%)" }}
            >
              {on ? <Check className={cn("size-4", c.color ? "text-white" : "text-white mix-blend-difference")} aria-hidden /> : null}
            </button>
          );
        })}
        {canEdit ? (
          <label
            title="Pick any colour"
            className={cn(
              "relative grid size-9 cursor-pointer place-items-center overflow-hidden rounded-full border border-dashed border-line-strong text-ink-2 hover:text-ink",
              selectedKey === "custom" && "border-solid ring-2 ring-ink ring-offset-2 ring-offset-surface",
            )}
            style={selectedKey === "custom" && shown ? { background: shown } : undefined}
          >
            <span className="sr-only">Pick any colour</span>
            {selectedKey === "custom" ? <Check className="size-4 text-white" aria-hidden /> : <Plus className="size-4" aria-hidden />}
            <input
              type="color"
              value={shown ?? "#3355ff"}
              onChange={(e) => {
                const hex = normalizeHex(e.target.value);
                if (hex) choose({ key: "custom", label: "Custom colour", color: hex, body: { color: hex } }, 400);
              }}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
        ) : null}
      </div>
      {shown && !isThemeable(shown) ? <p className="text-footnote text-ink-2">That colour is too close to grey, so MuseLaunch stays monochrome.</p> : null}
    </div>
  );
}
