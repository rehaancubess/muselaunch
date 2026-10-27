"use client";
import { useEffect } from "react";

/**
 * Global "Ask Muse" command bus. The command palette (shell) emits; feature modules listen.
 *
 * - `muselaunch:ai-edit` → { compositionId, instruction }  Studio (module C) should open its AI
 *   editor and submit `POST /compositions/:id/ai-edit` with this instruction.
 * - `muselaunch:open-command` → { prefill? }  Any component can open the palette.
 */
export type AiEditCommand = { compositionId: string; instruction: string };

const AI_EDIT = "muselaunch:ai-edit";
const OPEN = "muselaunch:open-command";

export function emitAiEdit(cmd: AiEditCommand) {
  window.dispatchEvent(new CustomEvent<AiEditCommand>(AI_EDIT, { detail: cmd }));
}

export function useAiEditCommand(handler: (cmd: AiEditCommand) => void) {
  useEffect(() => {
    const fn = (e: Event) => handler((e as CustomEvent<AiEditCommand>).detail);
    window.addEventListener(AI_EDIT, fn);
    return () => window.removeEventListener(AI_EDIT, fn);
  }, [handler]);
}

export function openCommandPalette(prefill?: string) {
  window.dispatchEvent(new CustomEvent<{ prefill?: string }>(OPEN, { detail: { prefill } }));
}

export function useOpenCommandListener(handler: (prefill?: string) => void) {
  useEffect(() => {
    const fn = (e: Event) => handler((e as CustomEvent<{ prefill?: string }>).detail?.prefill);
    window.addEventListener(OPEN, fn);
    return () => window.removeEventListener(OPEN, fn);
  }, [handler]);
}
