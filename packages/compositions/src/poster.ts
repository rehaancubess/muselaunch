/**
 * Poster frame: the first moment the opening scene's hook has fully settled. The opening scene is on
 * screen from frame 0 (./opening.ts: its entrances play as a short settle), so frame 0 already shows
 * the hook; the paused preview, the render poster and the export thumbnail park a beat later, once
 * the settle (and any entrance of a layer that starts a little later) has finished.
 */
import type { CompositionDoc } from "@muselaunch/contracts";
import { enterEndSec } from "./opening";

/** Layers that appear later than this (scene-relative) are not part of the opening frame. */
const OPENING_WINDOW_SEC = 1.5;
const MAX_POSTER_SEC = 2.5;

export function posterTimeSec(doc: CompositionDoc): number {
  const scene = doc.scenes[0];
  if (!scene) return 0;
  const window = Math.min(OPENING_WINDOW_SEC, scene.durationSec * 0.5);
  let settled = 0;
  let earliestExit = scene.durationSec;
  for (const l of scene.layers) {
    if (l.hidden || l.timing.start > window) continue;
    settled = Math.max(settled, l.timing.start + enterEndSec(0, l));
    const end = l.timing.end ?? scene.durationSec;
    const exit = l.animation.exit ? end - l.animation.exit.durationSec : end;
    if (exit > settled) earliestExit = Math.min(earliestExit, exit);
  }
  // A beat after everything has landed, before anything leaves or the scene ends.
  const t = Math.min(settled + 0.12, earliestExit - 0.05, scene.durationSec - 0.05, MAX_POSTER_SEC);
  return Math.max(0, Math.round(t * 100) / 100);
}
