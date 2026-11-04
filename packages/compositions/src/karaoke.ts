/**
 * Word timing for karaoke captions (pure; Node + browser). Muse Voice Transcribe times turns, not
 * words, and the AI voice is placed line by line, so each caption cue is timed inside: every word
 * gets a share of the cue weighted by its syllables, with a little extra after commas and full stops
 * (where speakers pause). Cues are paged into short phrases (≤ 6 words, ≤ 32 characters, a page
 * breaks after sentence punctuation) so a caption never runs past two lines.
 */

export interface TimedWord {
  word: string;
  /** Timeline seconds the word starts / ends being spoken (estimated). */
  at: number;
  until: number;
}

export interface CaptionPage {
  words: TimedWord[];
  /** When the page is on screen. */
  start: number;
  end: number;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;

/** Rough English syllable count (vowel groups, silent final e); digits count by pairs. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!w) return 0;
  if (/^\d+$/.test(w)) return Math.max(1, Math.ceil(w.length / 2) + 1);
  const groups = w.replace(/e$/, "").match(/[aeiouy]+/g)?.length ?? 0;
  return Math.max(1, groups);
}

/** Pause weight after a word's punctuation (in syllables). */
function pauseAfter(word: string): number {
  if (/[.!?…]["')\]]*$/.test(word)) return 0.9;
  if (/[,;:—–-]["')\]]*$/.test(word)) return 0.5;
  return 0;
}

/**
 * Words of a cue with estimated times inside [start, end]: a short lead-in, then each word's share
 * by weight (0.35 + syllables), pauses after punctuation, and a short tail before the cue ends.
 */
export function captionWordTimes(text: string, start: number, end: number): TimedWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const d = Math.max(0.05, end - start);
  const lead = Math.min(0.06, d * 0.04);
  const tail = Math.min(0.2, d * 0.1);
  const span = Math.max(0.05, d - lead - tail);
  const w = words.map((x) => 0.35 + syllables(x));
  const p = words.map((x, i) => (i < words.length - 1 ? pauseAfter(x) : 0));
  const total = w.reduce((a, b) => a + b, 0) + p.reduce((a, b) => a + b, 0);
  const k = span / total;
  const out: TimedWord[] = [];
  let t = start + lead;
  words.forEach((word, i) => {
    const until = t + w[i]! * k;
    out.push({ word, at: r3(t), until: r3(until) });
    t = until + p[i]! * k;
  });
  return out;
}

/** A cue's words in short pages; each page shows from its first word until the next page starts. */
export function captionPages(text: string, start: number, end: number, o: { maxWords?: number; maxChars?: number } = {}): CaptionPage[] {
  const maxWords = o.maxWords ?? 6;
  const maxChars = o.maxChars ?? 32;
  const words = captionWordTimes(text, start, end);
  // Sentences first (a page never straddles two), then each sentence in balanced chunks, so there
  // are no one-word orphans ("…three / taps.").
  const sentences: TimedWord[][] = [];
  let cur: TimedWord[] = [];
  for (const w of words) {
    cur.push(w);
    if (/[.!?…]["')\]]*$/.test(w.word)) {
      sentences.push(cur);
      cur = [];
    }
  }
  if (cur.length) sentences.push(cur);
  const chars = (ws: TimedWord[]) => ws.reduce((n, w, i) => n + w.word.length + (i ? 1 : 0), 0);
  const fits = (ws: TimedWord[]) => ws.length <= maxWords && chars(ws) <= maxChars;
  /** A run of words in the fewest balanced chunks that fit. */
  const balanced = (s: TimedWord[]): TimedWord[][] => {
    for (let k = Math.max(1, Math.ceil(s.length / maxWords)); k <= s.length; k++) {
      const chunks: TimedWord[][] = [];
      let i = 0;
      for (let c = 0; c < k; c++) {
        const size = Math.ceil((s.length - i) / (k - c));
        chunks.push(s.slice(i, i + size));
        i += size;
      }
      if (k === s.length || chunks.every((c) => chars(c) <= maxChars)) return chunks;
    }
    return [s];
  };
  const pages: TimedWord[][] = [];
  for (const s of sentences) {
    // Clauses (split after commas, semicolons, dashes) are joined while they fit on one page.
    const clauses: TimedWord[][] = [];
    let c: TimedWord[] = [];
    for (const w of s) {
      c.push(w);
      if (/[,;:—–]["')\]]*$/.test(w.word)) {
        clauses.push(c);
        c = [];
      }
    }
    if (c.length) clauses.push(c);
    let page: TimedWord[] = [];
    for (const cl of clauses) {
      if (page.length && fits([...page, ...cl])) {
        page = [...page, ...cl];
        continue;
      }
      if (page.length) pages.push(page);
      page = [];
      if (fits(cl)) page = cl;
      else pages.push(...balanced(cl));
    }
    if (page.length) pages.push(page);
  }
  return pages.map((ws, i) => ({ words: ws, start: i === 0 ? r3(start) : ws[0]!.at, end: i === pages.length - 1 ? r3(end) : pages[i + 1]![0]!.at }));
}
