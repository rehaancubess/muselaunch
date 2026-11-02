/**
 * The opening frame. On Reels, Shorts and TikTok the first frame is also the thumbnail, so a video
 * never opens on an empty backdrop: in the first scene, every layer that starts with the scene is on
 * screen from frame 0, and its entrance plays as a short settle (a slight scale and drift into place)
 * instead of appearing from nothing (from opacity 0, behind a mask, out of a blur or word by word).
 * Layers that start later in the scene keep their entrance. The compiler, the poster frame and the
 * video review's reading-time measurement all follow this rule.
 */
import type { Layer } from "@muselaunch/contracts";

/** Layers starting within this many seconds of the scene start are part of the opening frame. */
export const OPENING_START_SEC = 0.05;
/** The settle starts at most this late (an entrance delay is kept up to here)… */
const SETTLE_MAX_DELAY_SEC = 0.25;
/** …and lasts about as long as the entrance it replaces, within these bounds. */
const SETTLE_MIN_SEC = 0.6;
const SETTLE_MAX_SEC = 0.9;

type Enter = NonNullable<Layer["animation"]["enter"]>;

/** True for a layer of the first scene that is on screen from the scene's first frame. */
export function opensOnFirstFrame(sceneIndex: number, layer: Pick<Layer, "timing" | "hidden">): boolean {
  return sceneIndex === 0 && !layer.hidden && layer.timing.start < OPENING_START_SEC;
}

/** The settle that replaces an opening layer's entrance (seconds from the layer's start). */
export function settleTiming(enter: Pick<Enter, "delaySec" | "durationSec">): { delaySec: number; durationSec: number } {
  return {
    delaySec: Math.min(Math.max(0, enter.delaySec), SETTLE_MAX_DELAY_SEC),
    durationSec: Math.max(SETTLE_MIN_SEC, Math.min(SETTLE_MAX_SEC, enter.durationSec + 0.2)),
  };
}

/**
 * Seconds (from the layer's start) until a layer is fully on screen and still: the end of its
 * entrance, or of the settle that replaces it in the opening frame.
 */
export function enterEndSec(sceneIndex: number, layer: Pick<Layer, "timing" | "hidden" | "animation">): number {
  const enter = layer.animation.enter;
  if (!enter || enter.preset === "none") return 0;
  if (opensOnFirstFrame(sceneIndex, layer)) {
    const s = settleTiming(enter);
    return s.delaySec + s.durationSec;
  }
  return enter.delaySec + enter.durationSec;
}
