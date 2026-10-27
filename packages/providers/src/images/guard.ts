/**
 * Prompt guard for generated imagery (spec: generated images must never depict the user's app UI;
 * real screenshots/recordings are the only product truth). Two layers:
 *  1. Refuse prompts that ask for the app's interface/screens (the user is pointed to real screenshots).
 *  2. Append a fixed instruction so any device that appears has a blank/off screen and no UI or text.
 */
const UI_REQUEST =
  /\b(screenshots?|screen ?shots?|(app|application|product)('s)?\s+(ui|interface|screens?|dashboard|home ?screen|layout|onboarding|paywall)|user interface|\bui\b|ux mock(up)?|mock-?ups? of (the|my|our) app|(my|our|the) app('s)? (screen|interface|ui)|app screen|in-app (screen|view)|screen of (the|my|our) app|show (the|my|our) app)\b/i;

export const NO_UI_SUFFIX =
  "Important constraints: do not depict any app or website user interface, screenshots, dashboards, charts, buttons, or legible on-screen text. If a phone, tablet or laptop appears, its screen must be off or show only an abstract soft gradient. No logos or brand marks.";

export type PromptGuardResult = { ok: true; prompt: string } | { ok: false; reason: string; userMessage: string };

export function guardImagePrompt(prompt: string): PromptGuardResult {
  const p = prompt.trim().replace(/\s+/g, " ");
  if (UI_REQUEST.test(p)) {
    return {
      ok: false,
      reason: "prompt requests app UI",
      userMessage: "Generated images can't show your app's interface. Use a real screenshot or recording in a device frame instead, and generate only backgrounds, scenes or illustrations.",
    };
  }
  return { ok: true, prompt: `${p}\n\n${NO_UI_SUFFIX}` };
}
