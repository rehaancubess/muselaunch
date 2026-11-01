"use client";
/**
 * Simple Studio status rows: the Brand check of this version (one-tap validated fixes), the voice and
 * music in one line (with on/off), and "How this was made" (which Meta models did what). Each row
 * shows only real state from the same APIs the full editor uses; nothing is assumed or simulated.
 */
import { modelDisplayName, type BrandReview, type CompositionPatch, type Job } from "@muselaunch/contracts";
import { Button, JobProgress, Popover, Spinner, Switch, cn, useToast } from "@muselaunch/ui";
import { AudioLines, Check, ChevronRight, RefreshCw, ShieldAlert, ShieldCheck, Sparkles, Wand2 } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { isRunning, useGuardianActions, type ApplyFindingResponse, type ReviewsResponse } from "@/features/guardian/use-guardian";
import { api, errorMessage, wsPath } from "@/lib/api";
import { WorkspaceCostEstimate } from "@/lib/estimate";
import { useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";
import type { SoundState } from "./audio-panel";
import type { ClipObject } from "./clips";
import type { CommitResponse, CompositionDoc, MediaAsset } from "./types";
import type { VideoReviewsResponse } from "./video-review-panel";

function Row({ icon, tone = "neutral", title, status, detail, action, children }: { icon: ReactNode; tone?: "neutral" | "success" | "warning" | "danger"; title: string; status?: ReactNode; detail?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <div className="space-y-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-[12rem] flex-1 items-center gap-3">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-full [&>svg]:size-4",
              tone === "success" ? "bg-success-soft text-success" : tone === "warning" ? "bg-warning-soft text-warning" : tone === "danger" ? "bg-danger-soft text-danger" : "bg-mist text-ink-2",
            )}
            aria-hidden
          >
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-body-sm text-ink">
              <span className="font-medium">{title}</span>
              {status ? <span className="text-ink-2"> · {status}</span> : null}
            </p>
            {detail ? <p className="line-clamp-2 text-caption text-ink-3">{detail}</p> : null}
          </div>
        </div>
        {action ? <div className="ml-auto flex shrink-0 items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- Brand check

type BrandState = { latest: (BrandReview & { current?: boolean }) | null; query: { isLoading: boolean; error: unknown }; glimmer: ReviewsResponse["glimmer"] | null };

const openIssues = (r: BrandReview | null | undefined) => (r?.findings ?? []).filter((f) => !f.resolution && f.severity !== "info");
const fixableIssues = (r: BrandReview | null | undefined) => openIssues(r).filter((f) => (f.suggestedOps?.length ?? 0) > 0);

/** Wait for the re-review a fix started (rules + Glimmer answer in seconds). */
async function settled(workspaceId: string, compositionId: string, version: number, first: BrandReview): Promise<BrandReview | null> {
  let r = first;
  for (let i = 0; i < 60 && isRunning(r); i++) {
    await new Promise((res) => setTimeout(res, 1000));
    const page = await api.get<ReviewsResponse>(wsPath(workspaceId, "/reviews"), { query: { subjectId: compositionId, entity: "compositions", version } });
    r = page.items.find((x) => x.id === first.id) ?? page.items.find((x) => x.current) ?? r;
  }
  return isRunning(r) ? null : r;
}

export function BrandLine({
  workspaceId,
  compositionId,
  version,
  brand,
  onApplied,
  onDetails,
  disabled,
}: {
  workspaceId: string;
  compositionId: string;
  version: number;
  brand: BrandState;
  onApplied: (r: ApplyFindingResponse) => void;
  onDetails: () => void;
  disabled?: boolean;
}) {
  const { can } = useWorkspace();
  const toast = useToast();
  const actions = useGuardianActions(workspaceId);
  const [fixing, setFixing] = useState<{ done: number; total: number } | null>(null);
  const canWrite = can("content.write");
  const latest = brand.latest;
  const open = openIssues(latest);
  const fixable = fixableIssues(latest);
  const details = (
    <Button size="sm" variant="ghost" onClick={onDetails}>
      Details
    </Button>
  );

  /** Apply each validated fix in turn: every fix is a new version, re-checked before the next one. */
  const fixAll = async () => {
    if (!latest) return;
    const total = fixable.length;
    const tried = new Set<string>();
    let review: BrandReview | null = latest;
    let done = 0;
    setFixing({ done, total });
    try {
      while (review && done < Math.min(total + 2, 6)) {
        const next = fixableIssues(review).find((f) => !tried.has(`${f.category}:${f.message}`));
        if (!next) break;
        tried.add(`${next.category}:${next.message}`);
        const r: ApplyFindingResponse = await actions.apply(review.id, next.id);
        onApplied(r);
        done += 1;
        setFixing({ done, total: Math.max(total, done) });
        review = await settled(workspaceId, compositionId, r.version.version, r.reReview.review);
      }
      const left = openIssues(review).length;
      toast.success(done ? `Applied ${done} fix${done === 1 ? "" : "es"}` : "Nothing left to fix automatically", left ? `${left} thing${left === 1 ? "" : "s"} still need${left === 1 ? "s" : ""} your eye. Undo reverts a fix.` : "Brand check passed. Undo reverts a fix.");
    } catch (e) {
      toast.error(done ? `Applied ${done} fix${done === 1 ? "" : "es"}, then stopped` : "Couldn't apply the fix", errorMessage(e));
    } finally {
      setFixing(null);
      void actions.refresh();
    }
  };
  const runCheck = async () => {
    try {
      await actions.run({ entity: "compositions", id: compositionId }, { version });
    } catch (e) {
      toast.error("Couldn't start the Brand check", errorMessage(e));
    }
  };

  if (brand.query.isLoading) return <Row icon={<ShieldCheck />} title="Brand check" status={<Spinner size={12} label="Loading" />} />;
  if (brand.query.error) return null;
  if (fixing)
    return (
      <Row
        icon={<Wand2 />}
        title="Brand check"
        status={`Fixing ${Math.min(fixing.done + 1, fixing.total)} of ${fixing.total}…`}
        detail="Each fix is a new version, checked again before the next one."
        action={<Spinner size={16} label="Fixing" />}
      />
    );
  if (!latest)
    return (
      <Row
        icon={<ShieldCheck />}
        title="Brand check"
        status="not checked yet"
        detail="Your brand and facts, checked. Also runs when you render."
        action={
          canWrite ? (
            <Button size="sm" variant="secondary" loading={actions.busy === "run"} disabled={disabled} onClick={() => void runCheck()}>
              Check now
            </Button>
          ) : undefined
        }
      />
    );
  if (isRunning(latest)) return <Row icon={<ShieldCheck />} title="Brand check" status="checking this version…" action={<Spinner size={16} label="Checking" />} />;
  if (latest.status === "failed")
    return (
      <Row
        icon={<ShieldAlert />}
        tone="danger"
        title="Brand check"
        status="didn't finish"
        detail={latest.error ?? "Nothing was checked, so this isn't a pass."}
        action={
          canWrite ? (
            <Button size="sm" variant="secondary" loading={actions.busy === "run"} onClick={() => void actions.run({ entity: "compositions", id: compositionId }, { version, rerun: true }).catch((e) => toast.error("Couldn't start the Brand check", errorMessage(e)))}>
              Try again
            </Button>
          ) : undefined
        }
      />
    );
  if (!open.length) return <Row icon={<Check />} tone="success" title="Brand check" status="passed" detail={latest.summary} action={details} />;
  const blocking = open.some((f) => f.severity === "block");
  return (
    <Row
      icon={<ShieldAlert />}
      tone={blocking ? "danger" : "warning"}
      title="Brand check"
      status={`${open.length} thing${open.length === 1 ? "" : "s"} to fix`}
      detail={open[0]!.message}
      action={
        <>
          {canWrite && fixable.length ? (
            <Button size="sm" icon={<Wand2 className="size-4" aria-hidden />} disabled={disabled || actions.busy !== null} onClick={() => void fixAll()}>
              {fixable.length === open.length ? "Fix" : `Fix ${fixable.length}`}
            </Button>
          ) : null}
          {details}
        </>
      }
    />
  );
}

// ---------------------------------------------------------------- Sound

const VOICE_LABEL: Record<string, string> = { external_tts: "AI voice (OpenAI TTS)", founder_recording: "Your voice", user_upload: "Uploaded voice", generated: "Generated voice" };
const MUSIC_LABEL: Record<string, string> = { original_music: "Original music", licensed_music: "Licensed music", user_upload: "Your music", generated: "Generated music" };

export function SoundLine({ workspaceId, base, version, onCommitted, onRefresh, onDetails, disabled }: { workspaceId: string; base: string; version: number; onCommitted: (r: CommitResponse) => void; onRefresh: () => void; onDetails: () => void; disabled?: boolean }) {
  const { can } = useWorkspace();
  // Same query (and cache entry) as the Sound tab of the full editor.
  const sound = useApiQuery<SoundState>(`${base}/sound`, { query: { v: version } });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askVoice, setAskVoice] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob(workspaceId, jobId, {
    onSettled: (j) => {
      if (j.status === "succeeded") {
        onRefresh();
        void sound.refetch();
      }
    },
  });
  const s = sound.data;
  if (sound.isLoading && !s) return <Row icon={<AudioLines />} title="Sound" status={<Spinner size={12} label="Loading" />} />;
  if (!s) return null;
  const voice = s.tracks.find((t) => t.kind === "voiceover");
  const music = s.tracks.find((t) => t.kind === "music");
  const sfx = s.tracks.some((t) => t.kind === "sfx");
  const running = job.job && (job.job.status === "queued" || job.job.status === "running");
  const locked = disabled || busy !== null || !!running || !can("content.write");
  const line = [voice ? (VOICE_LABEL[voice.sourceLabel] ?? "Voiceover") : "No voice", music ? (MUSIC_LABEL[music.sourceLabel] ?? "Music") : "No music", ...(sfx ? ["effects"] : [])].join(" · ");
  const mood = music?.mood ? s.moods.find((m) => m.id === music.mood)?.label : undefined;
  const check = voice?.check;
  const detail = check
    ? check.passed
      ? `Voice checked by Muse Voice Transcribe · ${Math.round((1 - check.wer) * 100)}% word match`
      : `${Math.round(check.wer * 100)}% of words differ from the script (Muse Voice Transcribe). Listen before posting.`
    : voice?.sourceLabel === "external_tts"
      ? s.tts.disclosure
      : mood
        ? `${mood} · composed for this video by MuseLaunch`
        : undefined;

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
  const post = (key: string, path: string, body: Record<string, unknown>) =>
    call(key, async () => {
      const r = await api.post<CommitResponse | { job: Job }>(`${base}/sound/${path}`, { baseVersion: version, ...body });
      if ("job" in r) setJobId(r.job.id);
      else {
        onCommitted(r);
        void sound.refetch();
      }
    });
  const setMusic = (on: boolean) => (on ? post("music", "music", { mood: (s.storyboard?.musicMood && s.moods.find((m) => m.id === s.storyboard!.musicMood)?.id) ?? s.moods[0]?.id }) : post("music", "music", { enabled: false }));
  const setVoice = (on: boolean) => {
    if (on) return setAskVoice(true);
    setAskVoice(false);
    return call("voice", async () => {
      onCommitted(await api.del<CommitResponse>(`${base}/sound/voiceover`, { query: { baseVersion: version } }));
      void sound.refetch();
    });
  };
  /** Effects re-placed for the current scenes, then the same music re-composed to the new length. */
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
        setJobId(r.job.id);
      }
      void sound.refetch();
    });
  const voiceUnavailable = !voice && !s.tts.configured ? (!s.tts.ttsConfigured ? "AI voice (external TTS) isn't connected on this deployment." : "Muse Voice Transcribe isn't connected, so an AI voice can't be checked against the script.") : null;

  return (
    <Row
      icon={<AudioLines />}
      title="Sound"
      status={line}
      detail={detail}
      action={
        <>
          <label className="flex items-center gap-1.5 text-caption text-ink-2" title={voiceUnavailable ?? undefined}>
            Voice
            <Switch label="Voice" checked={!!voice || askVoice} disabled={locked || !!voiceUnavailable} onCheckedChange={(v) => void setVoice(v)} />
          </label>
          <label className="flex items-center gap-1.5 text-caption text-ink-2">
            Music
            <Switch label="Music" checked={!!music} disabled={locked} onCheckedChange={(v) => void setMusic(v)} />
          </label>
        </>
      }
    >
      {askVoice && !voice ? (
        <div className="ml-11 space-y-2 rounded-lg bg-mist px-3 py-2.5">
          {s.script.trim() ? (
            <>
              <p className="text-footnote text-ink">Add an AI voice reading the plan&apos;s script? It&apos;s a built-in OpenAI voice (never a clone), checked against the script by Muse Voice Transcribe and labelled as AI.</p>
              <WorkspaceCostEstimate operation="media.voiceover" params={{ text: s.script.trim(), source: "tts" }} />
              <div className="flex flex-wrap gap-2">
                <Button size="sm" icon={<Sparkles className="size-4" aria-hidden />} loading={busy === "tts"} disabled={locked} onClick={() => void post("tts", "voiceover", { source: "tts", voice: s.tts.defaultVoice, script: s.script.trim() }).then(() => setAskVoice(false))}>
                  Add AI voice
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setAskVoice(false)}>
                  Cancel
                </Button>
              </div>
            </>
          ) : (
            <p className="text-footnote text-ink-2">
              There&apos;s no script to read yet.{" "}
              <button type="button" className="font-medium text-accent hover:underline" onClick={onDetails}>
                Write one or record your own voice
              </button>
              .
            </p>
          )}
        </div>
      ) : null}
      {s.stale.music || s.stale.sfx ? (
        <div className="ml-11 flex items-center justify-between gap-2 rounded-lg bg-warning-soft px-3 py-2">
          <p className="min-w-0 text-footnote text-ink">The scenes changed since the sound was made.</p>
          <Button size="sm" variant="secondary" icon={<RefreshCw className="size-3.5" aria-hidden />} loading={busy === "refit"} disabled={locked} onClick={() => void refit()}>
            Re-fit
          </Button>
        </div>
      ) : null}
      {job.job && job.job.status !== "succeeded" ? <JobProgress className="ml-11" job={job.job} variant="row" onRetry={() => void job.retry()} retrying={job.retrying} /> : null}
      {error ? <p className="ml-11 text-footnote text-danger">{error}</p> : null}
    </Row>
  );
}

// ---------------------------------------------------------------- How this was made

interface RunDetail {
  run: { id: string; model: string; kind: string };
}

/**
 * The Meta models (and other tools) that made this exact video, from its own records: the plan's
 * agent run, applied AI edits, SAM cutouts/tracks used in the layers, the voice check, the Brand
 * check reviewer and Spark's review of the render.
 */
export function MadeWith({
  workspaceId,
  appId,
  base,
  doc,
  assets,
  objects,
  brandReviewer,
  videoReview,
}: {
  workspaceId: string;
  appId: string;
  base: string;
  doc: CompositionDoc;
  assets: MediaAsset[];
  objects: ClipObject[];
  brandReviewer: BrandReview["reviewer"] | null;
  videoReview: VideoReviewsResponse["current"] | undefined;
}) {
  const runId = doc.meta.generatedByRunId;
  const run = useApiQuery<RunDetail>(runId ? wsPath(workspaceId, `/agent-runs/${runId}`) : null, { staleTime: 10 * 60_000, retry: false });
  // Same query (and cache entry) as Ask Muse's "Earlier edits".
  const patches = useApiQuery<{ items: CompositionPatch[] }>(`${base}/patches`, { query: { limit: 10 } });
  const byId = new Map(assets.map((a) => [a.id, a]));
  const layers = doc.scenes.flatMap((s) => s.layers.filter((l) => !l.hidden));
  const screenCut = layers.some((l) => (l.type === "device" && byId.get(l.screenAssetId)?.sourceLabel === "sam_ui_crop") || (l.type === "image" && byId.get(l.assetId)?.sourceLabel === "sam_ui_crop"));
  const personCut = layers.some((l) => l.type === "video" && l.mask);
  const tracked = layers.some((l) => l.type === "effect" || l.anchor);
  const voice = doc.audio.find((a) => a.kind === "voiceover");
  const editModel = (patches.data?.items ?? []).find((p) => p.source === "ai" && p.status === "applied" && p.model)?.model;

  const items: { what: string; who: string; note?: string }[] = [];
  if (run.data?.run.model) items.push({ what: "Plan", who: modelDisplayName(run.data.run.model, { short: true }), note: "scenes, script and timing" });
  if (editModel) items.push({ what: "Edits", who: modelDisplayName(editModel, { short: true }), note: "only the scenes you asked about" });
  if (screenCut) items.push({ what: "App screens cut out", who: "SAM 3.1" });
  if (personCut) items.push({ what: "You cut out of your clip", who: "SAM 3.1" });
  if (tracked || (!personCut && objects.length)) items.push({ what: "Objects tracked in your clip", who: "SAM 3.1" });
  if (voice?.check) items.push({ what: "Voice checked against the script", who: "Muse Voice Transcribe" });
  else if (voice?.sourceLabel === "founder_recording" && doc.captions.source === "transcript") items.push({ what: "Captions timed to your voice", who: "Muse Voice Transcribe" });
  if (videoReview?.status === "succeeded") items.push({ what: "Watched the render", who: videoReview.reviewer.label ?? "Muse Spark" });
  if (brandReviewer) items.push({ what: "Brand check", who: brandReviewer.engine === "glimmer" ? "Muse Glimmer" : "brand rules", note: brandReviewer.engine === "glimmer" ? "runs privately on your own GPU" : brandReviewer.note });
  if (doc.audio.some((a) => a.sourceLabel === "original_music")) items.push({ what: "Music", who: "MuseLaunch", note: "original, composed for this video" });
  if (voice?.sourceLabel === "external_tts") items.push({ what: "Voice", who: "OpenAI TTS", note: "a built-in AI voice, labelled as AI" });
  items.push({ what: "Rendered", who: "HyperFrames" });

  // The one-line summary names Meta's models only; the popover lists every tool.
  const meta = items.filter((i) => /^(Muse |SAM )/.test(i.who)).slice(0, 4);
  const sentence = meta.map((i, k) => `${k === 0 ? i.what : i.what.toLowerCase()} by ${i.who}`).join(" · ");
  return (
    <Popover
      align="start"
      side="top"
      label="How this was made"
      className="w-[min(22rem,calc(100vw-32px))] p-0"
      trigger={
        <button type="button" className="group flex w-full items-start gap-1.5 rounded-md text-left text-caption text-ink-3 hover:text-ink-2 focus-visible:outline-none focus-visible:shadow-focus">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
          <span className="min-w-0">
            <span className="font-medium text-ink-2">How this was made</span>
            {sentence ? ` · ${sentence}` : ""}
            <ChevronRight className="ml-0.5 inline size-3 align-[-2px] opacity-60 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </span>
        </button>
      }
    >
      <div className="border-b border-line px-4 py-3">
        <p className="text-body-sm font-semibold text-ink">How this was made</p>
        <p className="text-caption text-ink-2">From this video&apos;s own records.</p>
      </div>
      <ul className="space-y-2 px-4 py-3">
        {items.map((i) => (
          <li key={i.what} className="flex items-start justify-between gap-3 text-footnote">
            <span className="text-ink-2">
              {i.what}
              {i.note ? <span className="block text-caption text-ink-3">{i.note}</span> : null}
            </span>
            <span className="shrink-0 font-medium text-ink">{i.who}</span>
          </li>
        ))}
      </ul>
      {runId && run.data ? (
        <div className="border-t border-line px-4 py-2.5">
          <Link href={routes.app(workspaceId, appId).run(runId)} className="text-footnote font-medium text-accent hover:underline">
            See every step of the plan&apos;s AI run
          </Link>
        </div>
      ) : null}
    </Popover>
  );
}
