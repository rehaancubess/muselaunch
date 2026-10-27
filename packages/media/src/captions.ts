import type { CaptionCue, Transcript } from "@muselaunch/contracts";

/**
 * Transcript → caption cues for compositions (module C) and SRT/VTT exports.
 *
 * Muse Voice Transcribe gives TURN-level timing only. Cues that fit one turn use the turn's exact
 * boundaries. Long turns are split at sentence/clause boundaries into ≤ `maxChars` chunks whose
 * times are distributed by character count *within* the turn: approximate, never presented as
 * word-level timing, and never crossing the turn's real start/end.
 */
export interface CueOptions {
  /** Max characters per cue (≈2 lines of 42). */
  maxChars?: number;
  /** Minimum on-screen time per cue when splitting. */
  minDurationSec?: number;
  /** Prefix the speaker label when the transcript has several speakers. */
  labelSpeakers?: boolean;
  /** Id namespace (must be Firestore-safe). Defaults to the transcript id. */
  idPrefix?: string;
}

function splitText(text: string, maxChars: number): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxChars) return clean ? [clean] : [];
  const sentences = clean.match(/[^.!?…,;:]+[.!?…,;:]*\s*/g) ?? [clean];
  const out: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const s of sentences) {
    if ((cur + s).trim().length <= maxChars) {
      cur += s;
      continue;
    }
    push();
    if (s.trim().length <= maxChars) {
      cur = s;
      continue;
    }
    // Very long clause: split on word boundaries.
    for (const w of s.trim().split(" ")) {
      if ((cur ? `${cur} ${w}` : w).length > maxChars) push();
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  push();
  return out;
}

export function transcriptToCaptionCues(transcript: Pick<Transcript, "id" | "text" | "turns" | "durationSec">, opts: CueOptions = {}): CaptionCue[] {
  const maxChars = opts.maxChars ?? 84;
  const minDur = opts.minDurationSec ?? 0.8;
  const prefix = (opts.idPrefix ?? transcript.id ?? "t").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "t";
  const turns =
    transcript.turns.length > 0
      ? transcript.turns
      : transcript.text && transcript.durationSec
        ? [{ startSec: 0, endSec: transcript.durationSec, text: transcript.text, speaker: undefined }]
        : [];
  const speakers = new Set(turns.map((t) => t.speaker).filter(Boolean));
  const label = (opts.labelSpeakers ?? speakers.size > 1) && speakers.size > 1;
  const cues: CaptionCue[] = [];
  turns.forEach((turn, ti) => {
    const chunks = splitText(turn.text, maxChars);
    const start = Math.max(0, turn.startSec);
    const end = Math.max(start, turn.endSec);
    const total = chunks.reduce((n, c) => n + c.length, 0) || 1;
    let t = start;
    chunks.forEach((chunk, ci) => {
      const share = ((end - start) * chunk.length) / total;
      const cueEnd = ci === chunks.length - 1 ? end : Math.min(end, t + Math.max(minDur, share));
      cues.push({
        id: `${prefix}-c${ti}-${ci}`,
        startSec: Math.round(t * 1000) / 1000,
        endSec: Math.round(Math.max(cueEnd, t) * 1000) / 1000,
        text: (label && turn.speaker ? `${turn.speaker}: ${chunk}` : chunk).slice(0, 300),
        speaker: turn.speaker?.slice(0, 60),
      });
      t = cueEnd;
    });
  });
  return cues.slice(0, 400);
}

const ts = (sec: number, sep: "," | ".") => {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}${sep}${String(ms % 1000).padStart(3, "0")}`;
};

export function cuesToSrt(cues: Pick<CaptionCue, "startSec" | "endSec" | "text">[]): string {
  return cues.map((c, i) => `${i + 1}\n${ts(c.startSec, ",")} --> ${ts(c.endSec, ",")}\n${c.text}\n`).join("\n");
}

export function cuesToVtt(cues: Pick<CaptionCue, "startSec" | "endSec" | "text">[]): string {
  return `WEBVTT\n\n${cues.map((c) => `${ts(c.startSec, ".")} --> ${ts(c.endSec, ".")}\n${c.text}\n`).join("\n")}`;
}
