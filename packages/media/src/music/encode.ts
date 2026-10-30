import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { ffmpeg } from "../ffmpeg";

/** Little-endian float32 PCM (interleaved when stereo). */
function interleave(left: Float32Array, right: Float32Array | null): Buffer {
  const ch = right ? 2 : 1;
  const buf = Buffer.alloc(left.length * 4 * ch);
  for (let i = 0; i < left.length; i++) {
    buf.writeFloatLE(left[i]!, i * 4 * ch);
    if (right) buf.writeFloatLE(right[i]!, i * 8 + 4);
  }
  return buf;
}

/** Encode float PCM (mono when `right` is null) to AAC in an MP4 audio container (.m4a). */
export async function encodeM4a(left: Float32Array, right: Float32Array | null, sampleRate: number, out: string, opts: { bitrateK?: number; signal?: AbortSignal; title?: string } = {}): Promise<void> {
  const pcm = interleave(left, right);
  await ffmpeg(
    [
      "-f", "f32le", "-ar", String(sampleRate), "-ac", right ? "2" : "1", "-i", "pipe:0",
      "-c:a", "aac", "-b:a", `${opts.bitrateK ?? 160}k`, "-movflags", "+faststart",
      "-map_metadata", "-1", ...(opts.title ? ["-metadata", `title=${opts.title.replace(/[\r\n]/g, " ").slice(0, 120)}`] : []),
      out,
    ],
    { stdin: Readable.from([pcm]), signal: opts.signal, timeoutMs: 120_000 },
  );
}

/** Decode any audio/video file to float PCM at `sampleRate` (mono or stereo), with optional filters. */
export async function decodePcm(input: string, rawOut: string, o: { sampleRate: number; channels: 1 | 2; filter?: string; signal?: AbortSignal }): Promise<Float32Array[]> {
  await ffmpeg(["-i", input, "-vn", ...(o.filter ? ["-filter:a", o.filter] : []), "-ac", String(o.channels), "-ar", String(o.sampleRate), "-f", "f32le", "-c:a", "pcm_f32le", rawOut], { signal: o.signal, timeoutMs: 120_000 });
  const raw = await readFile(rawOut);
  const all = new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length - (raw.length % 4)));
  if (o.channels === 1) return [all];
  const n = Math.floor(all.length / 2);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    l[i] = all[i * 2]!;
    r[i] = all[i * 2 + 1]!;
  }
  return [l, r];
}

/** 16-bit PCM WAV bytes (mono when `right` is omitted). */
export function wavBytes(left: Float32Array, right: Float32Array | null, sampleRate: number): Buffer {
  const ch = right ? 2 : 1;
  const n = left.length;
  const data = n * ch * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8);
  b.write("fmt ", 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * ch * 2, 28);
  b.writeUInt16LE(ch * 2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(data, 40);
  const q = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(q(left[i]!), 44 + i * ch * 2);
    if (right) b.writeInt16LE(q(right[i]!), 44 + i * 4 + 2);
  }
  return b;
}
