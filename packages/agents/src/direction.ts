import { modelDisplayName, MUSIC_MOOD_INFO, type CreativeDirection, type DirectionPacing, type TemplateId } from "@muselaunch/contracts";

/**
 * Storyboard side of Muse Wonder's creative direction (set by Growth Autopilot on the concept):
 * the lines Muse Spark works to, and an honest account of what the storyboard followed.
 */

const PACING_RULE: Record<DirectionPacing, string> = {
  punchy: "quick cuts: most scenes 2–3 s (more scenes in the same length)",
  steady: "an even rhythm: most scenes 3–4 s",
  "slow-burn": "fewer, longer shots: most scenes 4–5 s that build",
};

export function directorLabel(d: CreativeDirection): string {
  return modelDisplayName(d.model, { short: true }) || d.model;
}

/** Prompt block for the storyboard writer. The house rules (real UI, reading pace, verified claims) still win. */
export function creativeDirectionLines(d: CreativeDirection): string {
  return [
    `Creative direction from ${directorLabel(d)} (the campaign's creative director). Work to it; the editing rules above and the real-media and verified-claim rules still win if they conflict:`,
    `- Hook approach: ${d.hookApproach}`,
    `- Pacing: ${d.pacing}, ${PACING_RULE[d.pacing]}.`,
    `- Visual motif through the whole video: ${d.visualMotif}`,
    d.signatureShots.length ? `- Feature these shots (use each at least once where the media allows): ${d.signatureShots.join(", ")}.` : "",
    `- Music: set music.mood to "${d.musicMood}" (${MUSIC_MOOD_INFO[d.musicMood].label}).`,
    d.avoid ? `- Avoid: ${d.avoid}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export interface DirectionFollowed {
  /** Signature shots the storyboard used / left out. */
  used: TemplateId[];
  missing: TemplateId[];
  /** The music mood the storyboard will be scored with (Wonder's choice). */
  musicMood: CreativeDirection["musicMood"];
  /** Spark asked for a different mood; Wonder's choice was applied. */
  moodOverridden: boolean;
  /** Human-readable account for the run log. */
  summary: string;
}

/** Compare a storyboard to the direction. The music mood is applied as directed (deterministic). */
export function directionFollowed(d: CreativeDirection, out: { scenes: { template: string }[]; music?: { mood?: string } }): DirectionFollowed {
  const templates = new Set<string>(out.scenes.map((s) => s.template));
  const used = d.signatureShots.filter((t) => templates.has(t));
  const missing = d.signatureShots.filter((t) => !templates.has(t));
  const moodOverridden = Boolean(out.music?.mood) && out.music!.mood !== d.musicMood;
  const parts = [
    used.length ? `used ${used.join(", ")}` : "",
    missing.length ? `left out ${missing.join(", ")}` : "",
    `score: ${MUSIC_MOOD_INFO[d.musicMood].label}${moodOverridden ? ` (the storyboard suggested “${out.music!.mood}”; the director's choice was kept)` : ""}`,
  ].filter(Boolean);
  return { used, missing, musicMood: d.musicMood, moodOverridden, summary: `Followed ${directorLabel(d)}'s direction: ${parts.join("; ")}.` };
}
