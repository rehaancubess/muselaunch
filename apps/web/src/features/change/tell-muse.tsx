"use client";
/**
 * "Tell Muse what to change": one box, typed or spoken, used wherever something can change by just
 * saying it (Creator → Today's next post, the post sheet, the simple Studio). It only collects the
 * words: the caller decides what they change (a post's video or caption via POST /posts/:id/change,
 * or the Studio's own AI edit). Speaking records a short clip and transcribes it with Muse Voice
 * Transcribe (the Studio's spoken-edit path); the words land in the box so the person sees them, and
 * nothing is spent until they press the button. The cost line sits right under the box; quick chips
 * fill the box (or, in the Studio, act).
 */
import { Button, Spinner, cn } from "@muselaunch/ui";
import { ArrowUpRight, Mic, ScanEye, Sparkles, Square, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { baseMime, fmtClock, transcribeVoiceCommand } from "@/features/media/lib";
import { errorMessage } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

export interface TellMuseChip {
  key: string;
  label: string;
  /** Words put in the box (the person presses the button). */
  text?: string;
  /** Switch what the change is about (e.g. "Change the caption"). */
  target?: string;
  /** Acts straight away instead (the Studio's proposals, which are reviewed before they apply). */
  act?: () => void;
  hint?: string;
  /** Suggested by Muse Spark's review of the video. */
  fromSpark?: boolean;
  disabled?: boolean;
}

export interface TellMuseProps {
  appId?: string;
  label?: string;
  placeholder?: string;
  /** What the words change, when there's a choice (e.g. Video / Caption). */
  targets?: { value: string; label: string }[];
  target?: string;
  onTargetChange?: (value: string) => void;
  chips?: TellMuseChip[];
  /** Under the box: the credit cost and what happens next, in plain words. */
  footnote?: ReactNode;
  submitLabel?: string;
  busy?: boolean;
  disabled?: boolean;
  /** Return false to keep the words in the box (e.g. the request was refused). */
  onSubmit: (text: string, opts: { spoken: boolean; target?: string }) => void | boolean | Promise<void | boolean>;
  /** "Edit in detail ›": the full editor. */
  detailHref?: string;
  onDetail?: () => void;
  /** Right of the label (e.g. the Studio's "Only scene 2" scope). */
  headerRight?: ReactNode;
  autoFocus?: boolean;
  /** Progress and the result of the last change. */
  children?: ReactNode;
  className?: string;
  /** Show the label as a heading (default) or only to screen readers. */
  hideLabel?: boolean;
}

const MAX_SECONDS = 60;
const MIME_PREFS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];

type VoiceState = { phase: "idle" } | { phase: "recording"; seconds: number; level: number } | { phase: "listening"; stage: "uploading" | "transcribing" } | { phase: "error"; message: string };

/** Record a short spoken instruction and turn it into text (Muse Voice Transcribe). */
function useSpokenChange(appId: string | undefined, onText: (text: string) => void) {
  const { workspaceId } = useWorkspace();
  const [state, setState] = useState<VoiceState>({ phase: "idle" });
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; ctx: AudioContext; raf: number; timer: ReturnType<typeof setInterval>; cancelled: boolean } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const textRef = useRef(onText);
  textRef.current = onText;

  const stopTracks = () => {
    const r = rec.current;
    if (!r) return;
    clearInterval(r.timer);
    cancelAnimationFrame(r.raf);
    r.stream.getTracks().forEach((t) => t.stop());
    void r.ctx.close().catch(() => {});
  };
  useEffect(
    () => () => {
      if (rec.current) rec.current.cancelled = true;
      stopTracks();
      abort.current?.abort();
    },
    [],
  );

  const start = async () => {
    try {
      if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) throw new Error("This browser can’t record here. Type what to change instead.");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const mimeType = MIME_PREFS.find((m) => MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      mr.onstop = () => {
        const cancelled = rec.current?.cancelled;
        stopTracks();
        rec.current = null;
        if (cancelled) return setState({ phase: "idle" });
        const blob = new Blob(chunks, { type: baseMime(mr.mimeType || mimeType || "audio/webm") });
        const ac = new AbortController();
        abort.current = ac;
        setState({ phase: "listening", stage: "uploading" });
        transcribeVoiceCommand(workspaceId, blob, { appId, signal: ac.signal, onStage: (stage) => setState({ phase: "listening", stage }) })
          .then(({ text }) => {
            if (!text) return setState({ phase: "error", message: "Muse didn’t catch any words. Try again a little closer to the mic, or type it." });
            setState({ phase: "idle" });
            textRef.current(text);
          })
          .catch((e) => ((e as Error)?.name === "AbortError" ? setState({ phase: "idle" }) : setState({ phase: "error", message: errorMessage(e) })));
      };
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Uint8Array(analyser.fftSize);
      const startedAt = Date.now();
      const tick = () => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += ((v - 128) / 128) ** 2;
        const level = Math.min(1, Math.sqrt(sum / buf.length) * 4);
        setState((s) => (s.phase === "recording" ? { ...s, level } : s));
        if (rec.current) rec.current.raf = requestAnimationFrame(tick);
      };
      const timer = setInterval(() => {
        const seconds = (Date.now() - startedAt) / 1000;
        setState((s) => (s.phase === "recording" ? { ...s, seconds } : s));
        if (seconds >= MAX_SECONDS && mr.state === "recording") mr.stop();
      }, 200);
      rec.current = { mr, stream, ctx, raf: 0, timer, cancelled: false };
      rec.current.raf = requestAnimationFrame(tick);
      mr.start(500);
      setState({ phase: "recording", seconds: 0, level: 0 });
    } catch (e) {
      stopTracks();
      rec.current = null;
      setState({ phase: "error", message: (e as Error)?.name === "NotAllowedError" ? "The microphone is blocked for this site. Allow it in your browser, or type what to change." : errorMessage(e) });
    }
  };
  const stop = () => {
    const mr = rec.current?.mr;
    if (mr && mr.state === "recording") mr.stop();
  };
  const cancel = () => {
    if (rec.current) {
      rec.current.cancelled = true;
      if (rec.current.mr.state === "recording") rec.current.mr.stop();
    }
    abort.current?.abort();
    setState({ phase: "idle" });
  };
  return { state, start, stop, cancel, clearError: () => setState({ phase: "idle" }) };
}

export function TellMuse({
  appId,
  label = "Tell Muse what to change",
  placeholder = "e.g. Make the opening shorter",
  targets,
  target,
  onTargetChange,
  chips = [],
  footnote,
  submitLabel = "Change",
  busy,
  disabled,
  onSubmit,
  detailHref,
  onDetail,
  headerRight,
  autoFocus,
  children,
  className,
  hideLabel,
}: TellMuseProps) {
  const id = useId();
  const inputId = `${id}-text`;
  const [text, setText] = useState("");
  const [spoken, setSpoken] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const voice = useSpokenChange(appId, (t) => {
    setText(t);
    setSpoken(true);
    requestAnimationFrame(() => box.current?.focus());
  });
  const recording = voice.state.phase === "recording";
  const listening = voice.state.phase === "listening";
  const off = disabled || busy || recording || listening;

  useEffect(() => {
    if (autoFocus) box.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const submit = async () => {
    const t = text.trim();
    if (!t || off) return;
    const kept = await onSubmit(t, { spoken, target });
    if (kept !== false) {
      setText("");
      setSpoken(false);
    }
  };

  return (
    <section className={cn("space-y-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label id={`${id}-label`} htmlFor={inputId} className={cn("text-headline font-semibold text-ink", hideLabel && "sr-only")}>
          {label}
        </label>
        {targets && targets.length > 1 ? (
          <div role="radiogroup" aria-label="What to change" className="inline-flex rounded-full bg-mist p-0.5">
            {targets.map((t) => (
              <button
                key={t.value}
                type="button"
                role="radio"
                aria-checked={t.value === target}
                onClick={() => onTargetChange?.(t.value)}
                className={cn(
                  "min-h-9 rounded-full px-3.5 text-footnote font-medium transition-colors focus-visible:outline-none focus-visible:shadow-focus",
                  t.value === target ? "bg-surface text-ink shadow-raised" : "text-ink-2 hover:text-ink",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
        {headerRight}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="rounded-2xl border border-line-strong bg-surface transition-shadow focus-within:border-accent focus-within:shadow-focus"
      >
        <textarea
          ref={box}
          id={inputId}
          rows={2}
          value={text}
          maxLength={2000}
          placeholder={recording ? "Listening… tap Stop when you’re done" : listening ? "Muse is writing down what you said…" : placeholder}
          disabled={disabled || recording || listening}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setSpoken(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          className="block min-h-[72px] w-full resize-none rounded-2xl bg-transparent px-4 pt-3 text-body text-ink outline-none placeholder:text-ink-3 disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-2 px-2 pb-2">
          {recording ? (
            <>
              <Button type="button" size="lg" variant="secondary" className="min-w-11 px-3.5" icon={<Square className="size-3.5 fill-current" aria-hidden />} onClick={voice.stop}>
                Stop
              </Button>
              <span className="flex min-w-0 items-center gap-2 text-footnote text-ink-2" aria-live="polite">
                <span className="relative flex size-2.5">
                  <span className="absolute inset-0 animate-ping rounded-full bg-danger/60 motion-reduce:hidden" />
                  <span className="relative size-2.5 rounded-full bg-danger" />
                </span>
                <span className="tabular">{fmtClock(voice.state.phase === "recording" ? voice.state.seconds : 0)}</span>
                <span className="h-1.5 w-12 overflow-hidden rounded-full bg-mist" aria-hidden>
                  <span className="block h-full rounded-full bg-accent transition-[width] duration-100" style={{ width: `${Math.round((voice.state.phase === "recording" ? voice.state.level : 0) * 100)}%` }} />
                </span>
              </span>
              <button type="button" onClick={voice.cancel} className="ml-auto inline-flex min-h-11 items-center gap-1 rounded-full px-3 text-footnote text-ink-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-focus">
                <X className="size-3.5" aria-hidden />
                Cancel
              </button>
            </>
          ) : listening ? (
            <span className="flex min-h-11 items-center gap-2 px-2 text-footnote text-ink-2" aria-live="polite">
              <Spinner size={14} />
              {voice.state.phase === "listening" && voice.state.stage === "transcribing" ? "Muse Voice Transcribe is writing it down…" : "Sending your voice…"}
            </span>
          ) : (
            <>
              <Button type="button" size="lg" variant="ghost" className="min-w-11 px-3" icon={<Mic className="size-[18px]" aria-hidden />} onClick={() => void voice.start()} disabled={disabled || busy} aria-label="Say it instead (record)">
                <span className="hidden sm:inline">Say it</span>
              </Button>
              {spoken ? <span className="text-caption text-ink-3">From what you said</span> : null}
              <Button type="submit" size="lg" className="ml-auto" icon={<Sparkles className="size-4" aria-hidden />} loading={busy} disabled={off || !text.trim()}>
                {submitLabel}
              </Button>
            </>
          )}
        </div>
      </form>
      {voice.state.phase === "error" ? (
        <p className="flex items-start gap-2 text-footnote text-warning" role="alert">
          <span className="min-w-0 flex-1 text-pretty">{voice.state.message}</span>
          <button type="button" onClick={voice.clearError} className="shrink-0 font-medium text-accent hover:underline">
            OK
          </button>
        </p>
      ) : null}

      {footnote || detailHref || onDetail ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          {footnote ? <p className="min-w-0 text-caption text-ink-3 text-pretty">{footnote}</p> : <span />}
          {detailHref ? (
            <Link href={detailHref} className="inline-flex min-h-11 items-center gap-0.5 text-footnote font-medium text-accent hover:underline sm:min-h-0">
              Edit in detail
              <ArrowUpRight className="size-3.5" aria-hidden />
            </Link>
          ) : onDetail ? (
            <button type="button" onClick={onDetail} className="inline-flex min-h-11 items-center gap-0.5 text-footnote font-medium text-accent hover:underline sm:min-h-0">
              Edit in detail
              <ArrowUpRight className="size-3.5" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
      {chips.length ? (
        <ul className="flex flex-wrap gap-2" aria-label="Quick changes">
          {chips.map((chip) => (
            <li key={chip.key}>
              <button
                type="button"
                title={chip.hint}
                disabled={off || chip.disabled}
                onClick={() => {
                  if (chip.target) onTargetChange?.(chip.target);
                  if (chip.act) return chip.act();
                  if (chip.text !== undefined) {
                    setText(chip.text);
                    setSpoken(false);
                  }
                  requestAnimationFrame(() => box.current?.focus());
                }}
                className={cn(
                  "inline-flex min-h-11 items-center gap-1.5 rounded-full border px-3.5 text-footnote transition-colors focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50 sm:min-h-9",
                  chip.fromSpark ? "border-accent/30 bg-accent-soft/60 text-accent-ink hover:bg-accent-soft" : "border-line bg-surface text-ink hover:border-line-strong hover:bg-mist",
                )}
              >
                {chip.fromSpark ? (
                  <>
                    <ScanEye className="size-3.5" aria-hidden />
                    <span className="sr-only">From Muse Spark&apos;s review: </span>
                  </>
                ) : null}
                {chip.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      {children}
    </section>
  );
}
