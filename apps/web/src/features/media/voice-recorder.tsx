"use client";
/**
 * Owner: module D (Multimodal media). Record (MediaRecorder) or upload a founder brief / spoken edit,
 * upload it, and transcribe it with Muse Voice Transcribe. Shows speaker turns with turn-level timing
 * (the model has no word timestamps). Recordings of people need explicit consent; spoken edit
 * commands (`voice_command`) are the user's own instruction and return text in one request.
 */
import { Badge, Button, Card, Checkbox, ChoiceChips, CostEstimate, Notice, ProgressBar, cn } from "@muselaunch/ui";
import { Copy, Mic, RotateCcw, Square, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, uploadToSignedUrl, wsPath } from "@/lib/api";
import type { CompleteUploadResponse, UploadResponse } from "@/lib/api-types";
import { useWorkspace } from "@/lib/workspace";
import { baseMime, fetchEstimate, fmtClock, waitForJob, type TranscribeResponse, type TranscriptView } from "./lib";

export interface VoiceRecorderProps {
  appId?: string;
  purpose?: "founder_brief" | "voice_command" | "captions";
  onTranscript?: (text: string, transcriptId: string) => void;
  className?: string;
}

type Phase = "idle" | "recording" | "recorded" | "uploading" | "processing" | "transcribing" | "done" | "error";

const MAX_SECONDS = { founder_brief: 15 * 60, captions: 15 * 60, voice_command: 60 } as const;
const MIME_PREFS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const LANGS = ["English", "Hindi", "Tamil", "Telugu", "Bengali", "Marathi", "Kannada", "Spanish"] as const;
const COPY = {
  founder_brief: { title: "Founder brief", hint: "Tell us about your app in your own words: who it's for, what it does, why it's different. We'll add it to your App DNA as evidence for review.", role: "founder_clip" as const },
  captions: { title: "Record narration", hint: "Record a voice track; we'll transcribe it into captions with speaker turns.", role: "voiceover" as const },
  voice_command: { title: "Speak an edit", hint: "Say what to change, e.g. “Make the opening more engaging.”", role: "other" as const },
};

export default function VoiceRecorder({ appId, purpose = "founder_brief", onTranscript, className }: VoiceRecorderProps) {
  const { workspaceId: wid, can } = useWorkspace();
  const copy = COPY[purpose];
  const needsConsent = purpose !== "voice_command";
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [uploadPct, setUploadPct] = useState(0);
  const [consent, setConsent] = useState(false);
  const [langs, setLangs] = useState<string[]>([]);
  const [result, setResult] = useState<TranscriptView | null>(null);
  const [stage, setStage] = useState<string>("");
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number; timer: ReturnType<typeof setInterval> } | null>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => stopTracks(), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!blob) return setBlobUrl(null);
    const u = URL.createObjectURL(blob);
    setBlobUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);

  function stopTracks() {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.timer);
    cancelAnimationFrame(r.raf);
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => {});
    rec.current = null;
  }

  const startRecording = async () => {
    setError(null);
    setResult(null);
    try {
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error("Recording isn't supported in this browser. Upload a file instead.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mimeType = MIME_PREFS.find((m) => MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        const type = baseMime(mr.mimeType || mimeType || "audio/webm");
        setBlob(new Blob(chunks, { type }));
        setFileName(`recording-${new Date().toISOString().replace(/[:.]/g, "-")}.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`);
        setPhase("recorded");
        stopTracks();
      };
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / buf.length) * 4));
        if (rec.current) rec.current.raf = requestAnimationFrame(tick);
      };
      const startedAt = Date.now();
      const timer = setInterval(() => {
        const s = (Date.now() - startedAt) / 1000;
        setSeconds(s);
        if (s >= MAX_SECONDS[purpose]) mr.state === "recording" && mr.stop();
      }, 200);
      rec.current = { mr, stream, ctx, raf: 0, timer };
      rec.current.raf = requestAnimationFrame(tick);
      mr.start(1000);
      setSeconds(0);
      setPhase("recording");
    } catch (e) {
      stopTracks();
      setError((e as Error)?.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in your browser settings, or upload a file." : errorMessage(e));
      setPhase("error");
    }
  };

  const stopRecording = () => {
    const mr = rec.current?.mr;
    if (mr && mr.state === "recording") mr.stop();
  };

  const pickFile = (file: File | undefined) => {
    if (!file) return;
    setError(null);
    setResult(null);
    setBlob(file);
    setFileName(file.name);
    setSeconds(0);
    const probe = document.createElement(file.type.startsWith("video/") ? "video" : "audio");
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      if (Number.isFinite(probe.duration)) setSeconds(probe.duration);
      URL.revokeObjectURL(probe.src);
    };
    probe.src = URL.createObjectURL(file);
    setPhase("recorded");
  };

  const transcribe = useCallback(async () => {
    if (!blob) return;
    const ac = new AbortController();
    abort.current = ac;
    setError(null);
    const consentBody = needsConsent && consent ? { scope: "Speaker's permission to record, transcribe and use this recording for this app's marketing" } : undefined;
    try {
      setPhase("uploading");
      setUploadPct(0);
      const mimeType = baseMime(blob.type || "audio/webm");
      const up = await api.post<UploadResponse>(wsPath(wid, "/uploads"), { filename: fileName || "recording.webm", mimeType, bytes: blob.size, role: copy.role, appId, consent: consentBody });
      await uploadToSignedUrl(up.upload, new Blob([blob], { type: mimeType }), setUploadPct, ac.signal);
      setPhase("processing");
      const done = await api.post<CompleteUploadResponse>(wsPath(wid, `/assets/${up.asset.id}/complete`));
      if (done.job) {
        const probe = await waitForJob(wid, done.job.id, { signal: ac.signal, onUpdate: (j) => setStage(j.progress?.message ?? j.progress?.stage ?? "") });
        if (probe.status !== "succeeded") throw new Error(probe.error?.userMessage ?? "We couldn't process that recording.");
      }
      setPhase("transcribing");
      setStage("");
      const tr = await api.post<TranscribeResponse>(
        wsPath(wid, `/assets/${up.asset.id}/transcribe`),
        { purpose, consent: consentBody, languageBias: langs.length ? langs : undefined },
        { idempotent: true },
      );
      let transcriptId = tr.transcript.id;
      if (tr.job && tr.transcript.status !== "succeeded") {
        const j = await waitForJob(wid, tr.job.id, { signal: ac.signal, onUpdate: (x) => setStage(x.progress?.message ?? x.progress?.stage ?? "") });
        if (j.status !== "succeeded") throw new Error(j.error?.userMessage ?? j.error?.message ?? "Transcription failed.");
        transcriptId = tr.transcript.id;
      }
      const view = await api.get<TranscriptView>(wsPath(wid, `/transcripts/${transcriptId}`));
      setResult(view);
      setPhase("done");
      onTranscript?.(view.transcript.text, view.transcript.id);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return setPhase("recorded");
      setError(errorMessage(e));
      setPhase("error");
    } finally {
      abort.current = null;
    }
  }, [blob, needsConsent, consent, wid, fileName, copy.role, appId, purpose, langs, onTranscript]);

  const reset = () => {
    abort.current?.abort();
    stopTracks();
    setBlob(null);
    setResult(null);
    setError(null);
    setSeconds(0);
    setPhase("idle");
  };

  const busy = phase === "uploading" || phase === "processing" || phase === "transcribing";
  const canWrite = can("content.write");
  const compact = purpose === "voice_command";

  return (
    <Card padding={compact ? "md" : "lg"} className={cn("space-y-4", className)}>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-headline font-semibold text-ink">{copy.title}</h3>
          <p className="max-w-prose text-footnote text-ink-2">{copy.hint}</p>
        </div>
        <Badge tone="outline">Muse Voice Transcribe · Meta</Badge>
      </header>

      {/* Recorder */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl bg-mist px-4 py-4">
        {phase === "recording" ? (
          <Button variant="danger" size="lg" icon={<Square className="size-4" aria-hidden />} onClick={stopRecording}>
            Stop
          </Button>
        ) : (
          <Button size="lg" icon={<Mic className="size-4" aria-hidden />} onClick={() => void startRecording()} disabled={!canWrite || busy}>
            {blob ? "Record again" : "Record"}
          </Button>
        )}
        <div className="flex min-w-40 flex-1 items-center gap-3">
          <span className="w-12 tabular text-body-sm font-medium text-ink">{fmtClock(seconds)}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-mist-2" aria-hidden>
            <div className={cn("h-full rounded-full transition-[width] duration-100", phase === "recording" ? "bg-danger" : "bg-ink-3/40")} style={{ width: `${phase === "recording" ? Math.max(4, level * 100) : 0}%` }} />
          </div>
          {phase === "recording" ? <span className="text-caption text-ink-3">max {fmtClock(MAX_SECONDS[purpose])}</span> : null}
        </div>
        {!compact ? (
          <label className={cn("inline-flex cursor-pointer items-center gap-1.5 text-footnote font-medium text-accent hover:underline", (busy || phase === "recording") && "pointer-events-none opacity-50")}>
            <Upload className="size-3.5" aria-hidden />
            Upload a file
            <input type="file" accept="audio/*,video/mp4,video/quicktime" className="sr-only" onChange={(e) => pickFile(e.target.files?.[0])} disabled={!canWrite} />
          </label>
        ) : null}
      </div>

      {blobUrl && phase !== "recording" ? <audio src={blobUrl} controls className="w-full" aria-label="Your recording" /> : null}

      {needsConsent && blob ? (
        <Checkbox
          checked={consent}
          onCheckedChange={setConsent}
          label="This is my voice, or I have the speaker's permission"
          description="Required to transcribe and use recordings of people. Stored with the file."
        />
      ) : null}

      {blob && !compact && phase !== "done" ? (
        <div className="space-y-2">
          <p className="text-footnote text-ink-2">Languages spoken (optional, improves accuracy)</p>
          <ChoiceChips label="Languages" multiple value={langs} onChange={(v) => setLangs(v.slice(0, 5))} options={LANGS.map((l) => ({ value: l, label: l }))} />
        </div>
      ) : null}

      {blob && phase !== "done" && canWrite ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <CostEstimate operation="media.transcribe" params={{ durationSec: Math.max(1, Math.round(seconds)) }} fetchEstimate={fetchEstimate(wid)} />
          <div className="flex gap-2">
            {busy ? (
              <Button variant="ghost" onClick={() => abort.current?.abort()}>
                Cancel
              </Button>
            ) : null}
            <Button loading={busy} disabled={phase === "recording" || (needsConsent && !consent)} onClick={() => void transcribe()}>
              Transcribe
            </Button>
          </div>
        </div>
      ) : null}

      {busy ? (
        <div className="space-y-1.5" aria-live="polite">
          <p className="text-footnote text-ink-2">
            {phase === "uploading" ? `Uploading… ${uploadPct}%` : phase === "processing" ? "Preparing audio…" : "Transcribing…"}
            {stage ? ` · ${stage}` : ""}
          </p>
          <ProgressBar value={phase === "uploading" ? uploadPct : null} label="Transcription progress" />
        </div>
      ) : null}

      {error ? (
        <Notice tone="danger" action={blob ? <Button size="sm" variant="secondary" onClick={() => void transcribe()}>Try again</Button> : undefined}>
          {error}
        </Notice>
      ) : null}

      {result ? <TranscriptResult view={result} onReset={reset} /> : null}
    </Card>
  );
}

function TranscriptResult({ view, onReset }: { view: TranscriptView; onReset: () => void }) {
  const t = view.transcript;
  const [copied, setCopied] = useState(false);
  const speakers = [...new Set(t.turns.map((x) => x.speaker).filter(Boolean))] as string[];
  return (
    <section className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <p className="text-body-sm font-semibold text-ink">Transcript</p>
          {t.reusedFromTranscriptId ? <Badge tone="success">Reused · no new charge</Badge> : null}
          {speakers.length > 1 ? <Badge>{speakers.length} speakers</Badge> : null}
          {t.durationSec ? <Badge>{fmtClock(t.durationSec)}</Badge> : null}
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy className="size-3.5" aria-hidden />}
            onClick={() => void navigator.clipboard?.writeText(t.text).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={onReset}>
            New recording
          </Button>
        </div>
      </div>
      {!t.text ? (
        <Notice tone="warning">No speech was detected in this recording.</Notice>
      ) : t.turns.length ? (
        <ol className="space-y-2.5">
          {t.turns.map((turn, i) => (
            <li key={i} className="flex gap-3">
              <span className="w-20 shrink-0 pt-0.5 tabular text-caption text-ink-3">
                {fmtClock(turn.startSec)}–{fmtClock(turn.endSec)}
              </span>
              <div className="min-w-0 space-y-0.5">
                {turn.speaker ? <span className="text-caption font-semibold text-ink-2">Speaker {turn.speaker}</span> : null}
                <p className="text-body-sm text-ink">{turn.text}</p>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-body-sm text-ink">{t.text}</p>
      )}
      <p className="text-caption text-ink-3">Timing is per speaking turn from Muse Voice Transcribe; there are no word-level timestamps.</p>
    </section>
  );
}
