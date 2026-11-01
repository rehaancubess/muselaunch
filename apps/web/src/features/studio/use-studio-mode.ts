"use client";
import { useSearchParams } from "next/navigation";
import { useCallback, useSyncExternalStore } from "react";

/**
 * Which Studio opens: the simple view (preview + "Tell me what to change") or the full editor.
 * The person's choice is remembered per browser; `?mode=detail` / `?mode=simple` overrides it for
 * links and tests without changing what's remembered.
 */
export type StudioMode = "simple" | "detail";

const KEY = "ml.studio.mode";
const EVENT = "ml:studio-mode";
/** Used when storage is blocked (private windows, previews): the choice lasts for this tab. */
let memory: StudioMode | null = null;

const valid = (v: string | null | undefined): StudioMode | null => (v === "simple" || v === "detail" ? v : null);

function read(): StudioMode | null {
  try {
    const v = valid(window.localStorage.getItem(KEY));
    if (v) return v;
  } catch {
    /* storage blocked: fall back to memory */
  }
  return memory;
}

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

export function useStudioMode(): { mode: StudioMode; fromUrl: boolean; setMode: (m: StudioMode) => void } {
  const params = useSearchParams();
  const urlMode = valid(params.get("mode"));
  const stored = useSyncExternalStore(subscribe, read, () => null);
  const mode = urlMode ?? stored ?? "simple";

  const setMode = useCallback(
    (m: StudioMode) => {
      memory = m;
      try {
        window.localStorage.setItem(KEY, m);
      } catch {
        /* remembered in memory only */
      }
      // A ?mode= in the URL would keep overriding the choice: drop it.
      if (urlMode) {
        const sp = new URLSearchParams(window.location.search);
        sp.delete("mode");
        const qs = sp.toString();
        window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs ? `?${qs}` : ""}${window.location.hash}`);
      }
      window.dispatchEvent(new Event(EVENT));
    },
    [urlMode],
  );

  return { mode, fromUrl: urlMode !== null, setMode };
}
