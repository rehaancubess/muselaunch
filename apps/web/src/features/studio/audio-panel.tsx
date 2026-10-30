"use client";
/**
 * "Sound" tab (Track 3): original music (mood, new take, volume), automatic sound effects, and a
 * voiceover — an AI voice (external TTS, labelled, checked with Muse Voice Transcribe) or your own
 * recording. Every change is a new composition version (undoable); slow work runs as a job.
 */
import type { AudioTrack, Job, MediaAsset, MusicMood } from "@muselaunch/contracts";
import { Badge, Button, Checkbox, ErrorState, JobProgress, Notice, ProgressBar, SegmentedControl, Select, Skeleton, Switch, Textarea, cn } from "@muselaunch/ui";
import { AudioLines, Check, Mic, Music, RefreshCw, Sparkles, Square, Trash2, TriangleAlert, Upload, Wand2 } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { baseMime, waitForJob } from "@/features/media/lib";
import { api, errorMessage, uploadToSignedUrl, wsPath } from "@/lib/api";
import type { CompleteUploadResponse, Page, UploadResponse } from "@/lib/api-types";
import { WorkspaceCostEstimate } from "@/lib/estimate";
import { useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";
import type { CommitResponse } from "./types";


interface SoundAsset {
  id: string;
  title?: string;
  sourceLabel?: string;
  durationSec?: number;
  role: string;
  license?: { type: string; provider?: string; attribution?: string; restrictions?: string };
  generation?: { provider: string; model: string };
}

export interface SoundState {
  version: number;
  stale: { music: boolean; sfx: boolean };
  tracks: AudioTrack[];
  assets: Record<string, SoundAsset>;
  captions: { enabled: boolean; source: string; cues: number };
  settings: { music: boolean; sfx: boolean; aiVoiceover: boolean; voice?: string };
  moods: { id: MusicMood; label: string; description: string; bpm: [number, number] }[];
  storyboard: { voiceover: string; musicMood: string | null } | null;
  script: string;
  tts: {
    configured: boolean;
    ttsConfigured: boolean;
    transcribeConfigured: boolean;
    provider: string;
    model: string;
    voices: string[];
    defaultVoice: string;
    disclosure: string;
    checkThreshold: number;
  };
}

const Label = ({ children }: { children: ReactNode }) => <p className="text-caption font-semibold uppercase tracking-wide text-ink-3">{children}</p>;

/** Provenance chip for an audio track (never unlabelled). */
export function SoundSourceBadge({ track }: { track: Pick<AudioTrack, "sourceLabel" | "kind"> }) {
  switch (track.sourceLabel) {
    case "original_music":
      return (
        <Badge tone="neutral" icon={<Music aria-hidden />} title="Composed by MuseLaunch's own synthesizer for this video. Owned: no samples, no third-party music.">
          Original · MuseLaunch
        </Badge>
      );
    case "original_sfx":
      return (
        <Badge tone="neutral" icon={<AudioLines aria-hidden />} title="Synthesized by MuseLaunch. Owned.">
          Original effect
        </Badge>
      );
    case "external_tts":
      return (
        <Badge tone="accent" icon={<Sparkles aria-hidden />} title="AI-generated voice from an external text-to-speech provider. Disclose it to viewers.">
          AI voice · OpenAI TTS
        </Badge>
      );
    case "founder_recording":
      return <Badge tone="outline" icon={<Mic aria-hidden />}>Your voice</Badge>;
    case "licensed_music":
      return <Badge tone="neutral">Licensed music</Badge>;
    default:
      return <Badge tone="outline">Uploaded</Badge>;
  }
}

function useSoundJob(workspaceId: string, onDone: (job: Job) => void) {
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(workspaceId, jobId, { onSettled: onDone });
  return { job, start: setJobId, clear: () => setJobId(null) };
}

export function AudioPanel({
  workspaceId,
  base,
  appId,
  version,
  onCommitted,
  onRefresh,
  disabled,
}: {
  workspaceId: string;
  /** `/v1/workspaces/:wid/compositions/:id` */
  base: string;
  appId: string | null;
  version: number;
  onCommitted: (r: CommitResponse) => void;
  onRefresh: () => void;
  disabled?: boolean;
}) {
  const sound = useApiQuery<SoundState>(`${base}/sound`, { query: { v: version } });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const afterJob = (j: Job) => {
    if (j.status === "succeeded") {
      onRefresh();
      void sound.refetch();
    }
  };
  const musicJob = useSoundJob(workspaceId, afterJob);
  const voiceJob = useSoundJob(workspaceId, afterJob);

  if (sound.isLoading && !sound.data) {
    return (
      <div className="space-y-3 p-4">
        <Skeleton className="h-24 w-full" rounded="lg" />
        <Skeleton className="h-16 w-full" rounded="lg" />
        <Skeleton className="h-40 w-full" rounded="lg" />
      </div>
    );
  }
  if (sound.error || !sound.data) return <ErrorState className="m-4" message={sound.error?.userMessage ?? "Sound settings didn't load"} onRetry={() => void sound.refetch()} />;
  const s = sound.data;
  const music = s.tracks.find((t) => t.kind === "music");
  const voice = s.tracks.find((t) => t.kind === "voiceover");
  const effects = s.tracks.filter((t) => t.kind === "sfx");
  const autoFx = effects.filter((t) => t.auto);
  const locked = disabled || busy !== null;
  /** Effects re-placed for the current scenes, then the same music take re-composed to the new length. */
  const refit = () =>
    call("refit", async () => {
      let v = version;
      if (s.stale.sfx) {
        const r = await api.post<CommitResponse>(`${base}/sound/sfx`, { baseVersion: v, enabled: true });
        onCommitted(r);
        v = r.version.version;
      }
      if (s.stale.music && music) {
        const r = await api.post<{ job: Job }>(`${base}/sound/music`, { baseVersion: v, mood: music.mood, volume: music.volume });
        musicJob.start(r.job.id);
      }
      void sound.refetch();
    });

  const call = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const commit = (key: string, path: string, body: Record<string, unknown>) =>
    call(key, async () => {
      const r = await api.post<CommitResponse | { job: Job }>(`${base}/sound/${path}`, { baseVersion: version, ...body });
      if ("job" in r) {
        if (path === "music") musicJob.start(r.job.id);
        else voiceJob.start(r.job.id);
      } else {
        onCommitted(r);
        void sound.refetch();
      }
    });

  return (
    <div className="space-y-6 px-4 py-4">
      <header className="space-y-1">
        <div className="flex items-center gap-2 text-body-sm font-semibold text-ink">
          <AudioLines className="size-4 text-accent" aria-hidden /> Sound
        </div>
        <p className="text-footnote text-ink-2">Original music and effects are made for this video by MuseLaunch. Music dips automatically under a voice.</p>
      </header>
      {error ? (
        <Notice tone="danger" icon={<TriangleAlert className="size-4" aria-hidden />}>
          {error}
        </Notice>
      ) : null}
      {s.stale.music || s.stale.sfx ? (
        <Notice
          tone="warning"
          action={
            <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" aria-hidden />} loading={busy === "refit"} disabled={locked} onClick={() => void refit()}>
              Re-fit
            </Button>
          }
        >
          The scenes changed since the sound was made: {s.stale.music ? "the music ends at the old length" : ""}
          {s.stale.music && s.stale.sfx ? " and " : ""}
          {s.stale.sfx ? "effects sit at the old transitions" : ""}.
        </Notice>
      ) : null}

      {/* ---------------------------------------------------------------- Music */}
      <section className="space-y-3" aria-label="Music">
        <div className="flex items-center justify-between gap-2">
          <Label>Music</Label>
          {music ? <SoundSourceBadge track={music} /> : null}
        </div>
        {music ? (
          <p className="text-footnote text-ink-2">{s.assets[music.assetId]?.title ?? music.label ?? "Music"}</p>
        ) : (
          <p className="text-footnote text-ink-2">No music. Pick a mood to compose one for this video.</p>
        )}
        <div className="grid grid-cols-2 gap-1.5" role="radiogroup" aria-label="Music mood">
          {s.moods.map((m) => {
            const sel = music?.mood === m.id;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={sel}
                disabled={locked || musicJob.job.job?.status === "running"}
                title={m.description}
                onClick={() => void commit(`mood:${m.id}`, "music", { mood: m.id })}
                className={cn(
                  "rounded-lg border px-2.5 py-2 text-left transition-colors duration-150 disabled:opacity-60",
                  sel ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong",
                )}
              >
                <span className="flex items-center justify-between gap-1 text-footnote font-medium text-ink">
                  {m.label}
                  {sel ? <Check className="size-3.5 text-accent" aria-hidden /> : null}
                </span>
                <span className="block text-caption text-ink-3">
                  {m.bpm[0]}–{m.bpm[1]} BPM
                </span>
              </button>
            );
          })}
        </div>
        {music ? (
          <>
            <VolumeSlider label="Music volume" value={music.volume} disabled={locked} onCommit={(v) => void commit("volume", "music", { volume: v })} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" aria-hidden />} loading={busy === "regen"} disabled={locked} onClick={() => void commit("regen", "music", { mood: music.mood, regenerate: true })}>
                New take
              </Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="size-3.5" aria-hidden />} loading={busy === "nomusic"} disabled={locked} onClick={() => void commit("nomusic", "music", { enabled: false })}>
                Remove music
              </Button>
            </div>
          </>
        ) : null}
        {musicJob.job.job ? <JobProgress job={musicJob.job.job} variant="row" onRetry={() => void musicJob.job.retry()} retrying={musicJob.job.retrying} /> : null}
        <p className="text-caption text-ink-3">Composed by our own synthesizer to this video's exact length. Yours to use: no samples, no third-party music, no cost.</p>
      </section>

      {/* ---------------------------------------------------------------- Effects */}
      <section className="space-y-2" aria-label="Sound effects">
        <label className="flex items-start justify-between gap-3" htmlFor="sfx-on">
          <span className="min-w-0 space-y-0.5">
            <span className="block text-body-sm font-medium text-ink">Sound effects</span>
            <span className="block text-footnote text-ink-2">Whooshes on moving transitions, taps on app taps, a shimmer on the end card. Mixed low.</span>
          </span>
          <Switch id="sfx-on" label="Sound effects" checked={autoFx.length > 0} disabled={locked} onCheckedChange={(v) => void commit("sfx", "sfx", { enabled: v })} />
        </label>
        {autoFx.length ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Placed effects">
            {autoFx.map((t) => (
              <li key={t.id}>
                <Badge tone="neutral" title={`At ${t.startSec.toFixed(1)}s · original effect`}>
                  {t.label ?? t.sfx ?? "Effect"}
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- Voiceover */}
      <VoiceSection s={s} voice={voice} base={base} workspaceId={workspaceId} appId={appId} version={version} locked={locked} busy={busy} commit={commit} call={call} voiceJob={voiceJob} onCommitted={(r) => {
        onCommitted(r);
        void sound.refetch();
      }} />
    </div>
  );
}

function VolumeSlider({ label, value, onCommit, disabled }: { label: string; value: number; onCommit: (v: number) => void; disabled?: boolean }) {
  const [v, setV] = useState(Math.round(value * 100));
  useEffect(() => setV(Math.round(value * 100)), [value]);
  const done = () => {
    if (v !== Math.round(value * 100)) onCommit(v / 100);
  };
  return (
    <label className="flex items-center gap-3">
      <span className="w-14 shrink-0 text-footnote text-ink-2">Volume</span>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={v}
        aria-label={label}
        disabled={disabled}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={done}
        onKeyUp={done}
        className="h-1 min-w-0 flex-1 cursor-pointer accent-[var(--color-accent,#0071e3)]"
      />
      <span className="w-9 shrink-0 text-right text-footnote tabular-nums text-ink-2">{v}%</span>
    </label>
  );
}

function VoiceSection({
  s,
  voice,
  base,
  workspaceId,
  appId,
  version,
  locked,
  busy,
  commit,
  call,
  voiceJob,
  onCommitted,
}: {
  s: SoundState;
  voice: AudioTrack | undefined;
  base: string;
  workspaceId: string;
  appId: string | null;
  version: number;
  locked: boolean;
  busy: string | null;
  commit: (key: string, path: string, body: Record<string, unknown>) => Promise<void>;
  call: (key: string, fn: () => Promise<unknown>) => Promise<void>;
  voiceJob: ReturnType<typeof useSoundJob>;
  onCommitted: (r: CommitResponse) => void;
}) {
  const [mode, setMode] = useState<"ai" | "own">("ai");
  const [script, setScript] = useState(s.script);
  const [voiceName, setVoiceName] = useState(s.tts.defaultVoice);
  useEffect(() => setScript((cur) => cur || s.script), [s.script]);
  const running = voiceJob.job.job && (voiceJob.job.job.status === "queued" || voiceJob.job.job.status === "running");
  const check = voice?.check;
  const asset = voice ? s.assets[voice.assetId] : undefined;

  return (
    <section className="space-y-3" aria-label="Voiceover">
      <div className="flex items-center justify-between gap-2">
        <Label>Voiceover</Label>
        {voice ? <SoundSourceBadge track={voice} /> : null}
      </div>
      {voice ? (
        <div className="space-y-2 rounded-lg bg-mist px-3 py-2.5">
          <p className="truncate text-footnote font-medium text-ink">{asset?.title ?? voice.label ?? "Voiceover"}</p>
          {check ? (
            check.passed ? (
              <p className="flex items-center gap-1.5 text-caption text-success">
                <Check className="size-3.5" aria-hidden /> Checked with Muse Voice Transcribe · {Math.round((1 - check.wer) * 100)}% word match
              </p>
            ) : (
              <p className="flex items-start gap-1.5 text-caption text-warning">
                <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden /> {Math.round(check.wer * 100)}% of words differ from the script after {check.attempts} take{check.attempts === 1 ? "" : "s"} (Muse Voice Transcribe). Listen before publishing.
              </p>
            )
          ) : null}
          {voice.sourceLabel === "external_tts" ? <p className="text-caption text-ink-3">{s.tts.disclosure}</p> : null}
          <p className="text-caption text-ink-3">{s.captions.source === "transcript" && s.captions.enabled ? `Captions follow the voice (${s.captions.cues} cues, timed by Muse Voice Transcribe turns).` : "Captions use the script timing."}</p>
          <Button
            size="sm"
            variant="ghost"
            icon={<Trash2 className="size-3.5" aria-hidden />}
            loading={busy === "novoice"}
            disabled={locked}
            onClick={() =>
              void call("novoice", async () => {
                onCommitted(await api.del<CommitResponse>(`${base}/sound/voiceover`, { query: { baseVersion: version } }));
              })
            }
          >
            Remove voiceover
          </Button>
        </div>
      ) : (
        <p className="text-footnote text-ink-2">{s.storyboard?.voiceover === "tts" ? "The storyboard has narration. Add a voice to speak it." : "No voiceover. Music plays at full level."}</p>
      )}

      <SegmentedControl
        size="sm"
        fullWidth
        label="Voice source"
        value={mode}
        onChange={setMode}
        items={[
          { value: "ai", label: "AI voice", icon: <Wand2 className="size-3.5" aria-hidden /> },
          { value: "own", label: "Your voice", icon: <Mic className="size-3.5" aria-hidden /> },
        ]}
      />

      {mode === "ai" ? (
        <div className="space-y-3">
          {!s.tts.configured ? (
            <Notice tone="neutral">
              {!s.tts.ttsConfigured ? "AI voice (external TTS) isn't connected on this deployment." : "Muse Voice Transcribe isn't connected, so an AI voice can't be checked against the script."}
            </Notice>
          ) : null}
          <label className="block space-y-1.5">
            <span className="text-footnote font-medium text-ink">Script</span>
            <Textarea rows={5} value={script} maxLength={4000} onChange={(e) => setScript(e.target.value)} placeholder="What the voice should say." disabled={locked || !!running} />
          </label>
          <label className="block space-y-1.5">
            <span className="text-footnote font-medium text-ink">Voice</span>
            <Select selectSize="sm" value={voiceName} onChange={(e) => setVoiceName(e.target.value)} options={s.tts.voices.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))} disabled={locked || !!running} />
          </label>
          {script.trim() ? <WorkspaceCostEstimate operation="media.voiceover" params={{ text: script.trim(), source: "tts" }} note="Only what runs is charged; a regeneration happens only if the voice doesn't match the script." /> : null}
          <p className="text-caption text-ink-3">
            {s.tts.provider} ({s.tts.model}), a built-in voice (never a clone). We transcribe it back with Muse Voice Transcribe and regenerate once if more than {Math.round(s.tts.checkThreshold * 100)}% of words differ. The voice is labelled as AI-generated.
          </p>
          <Button
            size="sm"
            icon={<Wand2 className="size-3.5" aria-hidden />}
            loading={busy === "tts"}
            disabled={locked || !s.tts.configured || !script.trim() || !!running}
            onClick={() => void commit("tts", "voiceover", { source: "tts", voice: voiceName, script: script.trim() })}
          >
            {voice ? "Replace with AI voice" : "Generate AI voice"}
          </Button>
        </div>
      ) : (
        <OwnVoice workspaceId={workspaceId} appId={appId} disabled={locked || !!running} transcribeConfigured={s.tts.transcribeConfigured} onUse={(assetId, consent) => commit("own", "voiceover", { source: "recording", assetId, consent })} />
      )}
      {voiceJob.job.job ? <JobProgress job={voiceJob.job.job} variant="row" onRetry={() => void voiceJob.job.retry()} retrying={voiceJob.job.retrying} /> : null}
      {voiceJob.job.job?.status === "succeeded" && ((voiceJob.job.job.output?.data as { warnings?: string[] } | undefined)?.warnings?.length ?? 0) > 0 ? (
        <Notice tone="warning">{(voiceJob.job.job.output!.data as { warnings: string[] }).warnings[0]}</Notice>
      ) : null}
    </section>
  );
}

const MIME_PREFS = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const MAX_RECORD_SEC = 180;

/** Record in the browser or pick a file, upload it (with consent), then use it as the voiceover. */
function OwnVoice({ workspaceId, appId, disabled, transcribeConfigured, onUse }: { workspaceId: string; appId: string | null; disabled: boolean; transcribeConfigured: boolean; onUse: (assetId: string, consent: { scope: string }) => Promise<void> }) {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [name, setName] = useState("");
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [consent, setConsent] = useState(false);
  const [phase, setPhase] = useState<"idle" | "uploading" | "processing">("idle");
  const [pct, setPct] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const rec = useRef<{ mr: MediaRecorder; stream: MediaStream; timer: ReturnType<typeof setInterval> } | null>(null);
  const url = useObjectUrl(blob);
  // Recordings already in the app (founder clips, earlier voice uploads): same query as the media drawer.
  const assets = useApiQuery<Page<MediaAsset>>(appId ? wsPath(workspaceId, "/assets") : null, { query: { appId: appId ?? undefined, limit: 120 } });
  const existing = (assets.data?.items ?? []).filter((a) => (a.role === "founder_clip" || a.role === "voiceover") && (a.kind === "audio" || a.kind === "video") && a.hasAudio !== false && a.status === "ready" && a.origin !== "derived");
  const [pick, setPick] = useState("");

  useEffect(
    () => () => {
      const r = rec.current;
      if (r) {
        clearInterval(r.timer);
        r.stream.getTracks().forEach((t) => t.stop());
      }
    },
    [],
  );

  const start = async () => {
    setErr(null);
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
        setName(`voiceover-${Date.now()}.${type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm"}`);
        setRecording(false);
        clearInterval(rec.current?.timer);
        stream.getTracks().forEach((t) => t.stop());
        rec.current = null;
      };
      const t0 = Date.now();
      const timer = setInterval(() => {
        const sec = (Date.now() - t0) / 1000;
        setSeconds(sec);
        if (sec >= MAX_RECORD_SEC && mr.state === "recording") mr.stop();
      }, 200);
      rec.current = { mr, stream, timer };
      mr.start(1000);
      setSeconds(0);
      setRecording(true);
    } catch (e) {
      setErr((e as Error)?.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in your browser, or upload a file." : errorMessage(e));
    }
  };
  const stop = () => rec.current?.mr.state === "recording" && rec.current.mr.stop();

  const use = async () => {
    if (!blob) return;
    setErr(null);
    const scope = "My own voice (or the speaker's permission) to use this recording as this video's voiceover";
    try {
      setPhase("uploading");
      const mimeType = baseMime(blob.type || "audio/webm");
      const up = await api.post<UploadResponse>(wsPath(workspaceId, "/uploads"), { filename: name || "voiceover.webm", mimeType, bytes: blob.size, role: "voiceover", appId: appId ?? undefined, consent: { scope } });
      await uploadToSignedUrl(up.upload, new Blob([blob], { type: mimeType }), setPct);
      setPhase("processing");
      const done = await api.post<CompleteUploadResponse>(wsPath(workspaceId, `/assets/${up.asset.id}/complete`));
      if (done.job) {
        const j = await waitForJob(workspaceId, done.job.id);
        if (j.status !== "succeeded") throw new Error(j.error?.userMessage ?? "We couldn't process that recording.");
      }
      await onUse(up.asset.id, { scope });
      setBlob(null);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setPhase("idle");
    }
  };

  return (
    <div className="space-y-3">
      {!transcribeConfigured ? <Notice tone="neutral">Muse Voice Transcribe isn't connected, so captions can't be timed to your voice yet.</Notice> : null}
      <div className="flex flex-wrap items-center gap-2">
        {recording ? (
          <Button size="sm" variant="secondary" icon={<Square className="size-3.5" aria-hidden />} onClick={stop}>
            Stop · {Math.floor(seconds / 60)}:{String(Math.floor(seconds % 60)).padStart(2, "0")}
          </Button>
        ) : (
          <Button size="sm" variant="secondary" icon={<Mic className="size-3.5" aria-hidden />} disabled={disabled || phase !== "idle"} onClick={() => void start()}>
            Record
          </Button>
        )}
        <label className={cn("inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-full px-3 text-footnote font-medium text-ink-2 hover:bg-mist", (disabled || recording) && "pointer-events-none opacity-50")}>
          <Upload className="size-3.5" aria-hidden /> Upload audio
          <input
            type="file"
            accept="audio/*,video/mp4,video/quicktime,video/webm"
            className="sr-only"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setBlob(f);
                setName(f.name);
              }
              e.target.value = "";
            }}
          />
        </label>
      </div>
      {blob && url ? <audio controls src={url} className="h-9 w-full" /> : null}
      {blob ? <Checkbox checked={consent} onCheckedChange={setConsent} label="This is my voice, or I have the speaker's permission to use it." /> : null}
      {phase === "uploading" ? <ProgressBar value={pct} label="Uploading" /> : null}
      {err ? <Notice tone="danger">{err}</Notice> : null}
      <Button size="sm" icon={<Check className="size-3.5" aria-hidden />} disabled={!blob || !consent || disabled || phase !== "idle" || !transcribeConfigured} loading={phase !== "idle"} onClick={() => void use()}>
        Use as voiceover
      </Button>
      {existing.length ? (
        <div className="space-y-2 border-t border-line pt-3">
          <span className="block text-footnote font-medium text-ink">Or use a recording you already added</span>
          <Select selectSize="sm" value={pick} placeholder="Choose a recording" onChange={(e) => setPick(e.target.value)} options={existing.map((a) => ({ value: a.id, label: `${a.title ?? a.originalFilename ?? "Recording"}${a.durationSec ? ` · ${Math.round(a.durationSec)}s` : ""}` }))} disabled={disabled} />
          {pick ? <Checkbox checked={consent} onCheckedChange={setConsent} label="This is my voice, or I have the speaker's permission to use it." /> : null}
          <Button size="sm" variant="secondary" disabled={!pick || !consent || disabled || !transcribeConfigured} onClick={() => void onUse(pick, { scope: "My own voice (or the speaker's permission) to use this recording as this video's voiceover" }).catch((e) => setErr(errorMessage(e)))}>
            Use this recording
          </Button>
        </div>
      ) : null}
      <p className="text-caption text-ink-3">We level your recording and time the captions to it with Muse Voice Transcribe (turn-level timing).</p>
    </div>
  );
}

function useObjectUrl(blob: Blob | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!blob) return setUrl(null);
    const u = URL.createObjectURL(blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [blob]);
  return url;
}
