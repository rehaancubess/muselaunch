"use client";
import type { Job } from "@muselaunch/contracts";
import { Badge, Button, JobProgress, Notice, SegmentedControl, Textarea, cn, useToast } from "@muselaunch/ui";
import { Check, Mic, ScanSearch, Sparkles, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { VoiceRecorder } from "@/features/media";
import { ApiError, api, errorMessage } from "@/lib/api";
import { useAiEditCommand } from "@/lib/commands";
import { useJob } from "@/lib/jobs";
import { useApiQuery } from "@/lib/query";
import { describeOp } from "./ops";
import type { AiEditResponse, CommitResponse, CompositionDoc, CompositionPatch, PatchDetailResponse } from "./types";

const SUGGESTIONS = ["Make the opening more engaging", "Make this scene punchier", "Tighten the whole video to about 10 seconds", "Use a calmer, more premium tone in the headlines"];
/** Extra suggestions once a founder clip has been analysed (Spark sees the tracked objects). */
const OBJECT_SUGGESTIONS = ["Put the app behind me in the opening", "Add a label that follows my phone", "Spotlight my phone when I mention the app"];

interface Turn {
  id: string;
  instruction: string;
  spoken?: boolean;
  scope: string[];
  jobId: string | null;
  initialJob: Job | null;
  patchId: string | null;
  error: string | null;
}

function PatchCard({ base, patchId, doc, onApplied, onUndo, disabled }: { base: string; patchId: string; doc: CompositionDoc; onApplied: (r: CommitResponse) => void; onUndo: () => void; disabled?: boolean }) {
  const toast = useToast();
  const detail = useApiQuery<PatchDetailResponse>(`${base}/patches/${patchId}`, { refetchInterval: (q) => (q.state.data?.patch.status === "proposed" && !q.state.data.patch.ops.length ? 2500 : false) });
  const [busy, setBusy] = useState<"apply" | "reject" | null>(null);
  const p = detail.data?.patch;
  if (!p) return null;
  const sceneName = (id: string) => doc.scenes.find((s) => s.id === id)?.name ?? id;
  const act = async (kind: "apply" | "reject") => {
    setBusy(kind);
    try {
      if (kind === "apply") {
        const r = await api.post<CommitResponse>(`${base}/patches/${patchId}/apply`);
        onApplied(r);
      } else await api.post(`${base}/patches/${patchId}/reject`);
      await detail.refetch();
    } catch (e) {
      toast.error(kind === "apply" ? "Couldn't apply the edit" : "Couldn't reject", e instanceof ApiError ? ((e.details?.errors as string[] | undefined)?.[0] ?? e.userMessage) : errorMessage(e));
      await detail.refetch();
    } finally {
      setBusy(null);
    }
  };
  if (p.status === "proposed" && !p.ops.length) return <p className="text-footnote text-ink-2">Waiting for the edit…</p>;
  const affected = detail.data?.preview?.affectedSceneIds ?? p.affectedSceneIds;
  return (
    <div className="space-y-2.5 rounded-lg border border-line bg-surface p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-body-sm font-medium text-ink">{p.summary}</p>
        <Badge tone={p.status === "applied" ? "success" : p.status === "rejected" ? "neutral" : p.status === "invalid" ? "danger" : "accent"}>{p.status}</Badge>
      </div>
      {affected.length ? (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-caption text-ink-3">Changes</span>
          {affected.map((id) => (
            <Badge key={id} tone="outline">
              {sceneName(id)}
            </Badge>
          ))}
          <span className="text-caption text-ink-3">· other scenes stay exactly as they are</span>
        </div>
      ) : null}
      <ul className="space-y-1 border-l-2 border-accent-soft pl-2.5">
        {p.ops.slice(0, 8).map((op, i) => (
          <li key={i} className="text-footnote text-ink-2">
            {describeOp(op, doc)}
          </li>
        ))}
        {p.ops.length > 8 ? <li className="text-caption text-ink-3">…and {p.ops.length - 8} more changes</li> : null}
      </ul>
      {p.validationErrors.length || detail.data?.preview?.errors.length ? (
        <Notice tone="danger" title="This edit can't be applied">
          {(p.validationErrors[0] ?? detail.data?.preview?.errors[0]) || ""}
        </Notice>
      ) : null}
      {p.memoryRefs.length ? <p className="text-caption text-ink-3">Used {p.memoryRefs.length} saved brand preference{p.memoryRefs.length === 1 ? "" : "s"}.</p> : null}
      {p.status === "proposed" ? (
        <div className="flex gap-2">
          <Button size="sm" icon={<Check className="size-4" aria-hidden />} loading={busy === "apply"} disabled={disabled || !!busy || detail.data?.preview?.applicable === false} onClick={() => act("apply")}>
            Apply
          </Button>
          <Button size="sm" variant="secondary" icon={<X className="size-4" aria-hidden />} loading={busy === "reject"} disabled={!!busy} onClick={() => act("reject")}>
            Reject
          </Button>
        </div>
      ) : p.status === "applied" ? (
        <div className="flex items-center gap-2 text-footnote text-success">
          <Check className="size-4" aria-hidden /> Applied as version {p.resultVersion}
          <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" aria-hidden />} onClick={onUndo} disabled={disabled}>
            Undo
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function TurnView({ turn, workspaceId, base, doc, onApplied, onUndo, onPatchReady, disabled }: { turn: Turn; workspaceId: string; base: string; doc: CompositionDoc; onApplied: (r: CommitResponse) => void; onUndo: () => void; onPatchReady: () => void; disabled?: boolean }) {
  const live = useJob(workspaceId, turn.jobId, { initial: turn.initialJob, onSettled: onPatchReady });
  const job = live.job;
  const notConnected = job?.status === "failed" && job.error?.code === "PROVIDER_NOT_CONFIGURED";
  return (
    <li className="space-y-2">
      <div className="ml-auto max-w-[90%] rounded-2xl rounded-br-md bg-accent px-3 py-2 text-body-sm text-white">
        {turn.spoken ? (
          <span className="mb-0.5 flex items-center gap-1 text-caption text-white/80">
            <Mic className="size-3" aria-hidden /> Spoken
          </span>
        ) : null}
        {turn.instruction}
        {turn.scope.length ? <span className="mt-0.5 block text-caption text-white/80">Only: {turn.scope.map((id) => doc.scenes.find((s) => s.id === id)?.name ?? id).join(", ")}</span> : null}
      </div>
      {turn.error ? <Notice tone="danger">{turn.error}</Notice> : null}
      {job && job.status !== "succeeded" ? (
        notConnected ? (
          <Notice tone="neutral" title="AI editing isn't connected on this deployment">
            The Spark model key isn't configured, so no edit was made. You can still edit directly in the timeline and inspector.
          </Notice>
        ) : (
          <JobProgress job={job} variant="row" title="Muse Spark is editing" onCancel={() => void live.cancel()} onRetry={() => void live.retry()} cancelling={live.cancelling} retrying={live.retrying} />
        )
      ) : null}
      {turn.patchId && (!job || job.status === "succeeded" || job.status === "needs_approval") ? <PatchCard base={base} patchId={turn.patchId} doc={doc} onApplied={onApplied} onUndo={onUndo} disabled={disabled} /> : null}
    </li>
  );
}

/** Conversational editor: instruction → Spark patch (scene-scoped when a scene is selected) → review → apply/reject. */
export function AiPanel({
  workspaceId,
  base,
  compositionId,
  doc,
  baseVersion,
  selectedSceneId,
  appId,
  clipAnalysisIds = [],
  trackedLabels = [],
  onApplied,
  onUndo,
  disabled,
}: {
  workspaceId: string;
  base: string;
  compositionId: string;
  doc: CompositionDoc;
  baseVersion: number;
  selectedSceneId: string | null;
  appId?: string;
  /** Analyses of the clips in this video: Spark gets their tracked objects to direct object-aware effects. */
  clipAnalysisIds?: string[];
  trackedLabels?: string[];
  onApplied: (r: CommitResponse) => void;
  onUndo: () => void;
  disabled?: boolean;
}) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"scene" | "all">("all");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [sending, setSending] = useState(false);
  const [voice, setVoice] = useState(false);
  const clipIds = useRef(clipAnalysisIds);
  clipIds.current = clipAnalysisIds;
  const listRef = useRef<HTMLUListElement>(null);
  const recent = useApiQuery<{ items: CompositionPatch[] }>(`${base}/patches`, { query: { limit: 10 } });

  const send = useCallback(
    async (instruction: string, sceneIds: string[], spoken = false) => {
      const id = `t${Date.now()}`;
      setTurns((t) => [...t, { id, instruction, spoken, scope: sceneIds, jobId: null, initialJob: null, patchId: null, error: null }]);
      setSending(true);
      try {
        const r = await api.post<AiEditResponse>(`${base}/ai-edit`, { baseVersion, instruction, sceneIds, ...(clipIds.current.length ? { clipAnalysisIds: clipIds.current.slice(0, 4) } : {}) }, { idempotent: true });
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, jobId: r.job.id, initialJob: r.job, patchId: r.patch.id } : x)));
      } catch (e) {
        setTurns((t) => t.map((x) => (x.id === id ? { ...x, error: errorMessage(e) } : x)));
      } finally {
        setSending(false);
      }
    },
    [base, baseVersion],
  );

  useAiEditCommand(
    useCallback(
      (cmd) => {
        if (cmd.compositionId === compositionId && cmd.instruction.trim()) void send(cmd.instruction.trim(), []);
      },
      [compositionId, send],
    ),
  );

  useEffect(() => {
    listRef.current?.lastElementChild?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length]);

  const submit = () => {
    const v = text.trim();
    if (!v) return;
    setText("");
    void send(v, scope === "scene" && selectedSceneId ? [selectedSceneId] : []);
  };
  const sceneName = doc.scenes.find((s) => s.id === selectedSceneId)?.name;
  const earlier = (recent.data?.items ?? []).filter((p) => p.source === "ai" && !turns.some((t) => t.patchId === p.id)).slice(0, 5);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ul ref={listRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {!turns.length ? (
          <li className="space-y-3">
            <div className="flex items-center gap-2 text-body-sm font-medium text-ink">
              <Sparkles className="size-4 text-accent" aria-hidden /> Ask Muse to edit this video
            </div>
            <p className="text-footnote text-ink-2">Edits change only what you ask for. Each one is a reviewable change you can apply, reject or undo.</p>
            {trackedLabels.length ? (
              <p className="flex items-start gap-1.5 rounded-md bg-accent-soft/50 px-2.5 py-2 text-footnote text-ink-2">
                <ScanSearch className="mt-0.5 size-3.5 shrink-0 text-accent" aria-hidden />
                <span>
                  Muse can see the tracked {trackedLabels.slice(0, 4).join(", ")} in your clip, so it can make effects and labels follow them.
                </span>
              </p>
            ) : null}
            <div className="flex flex-wrap gap-1.5">
              {[...(trackedLabels.length ? OBJECT_SUGGESTIONS : []), ...SUGGESTIONS].map((s) => (
                <button key={s} type="button" className="rounded-full border border-line px-2.5 py-1 text-footnote text-ink-2 hover:border-line-strong hover:text-ink" onClick={() => setText(s)}>
                  {s}
                </button>
              ))}
            </div>
            {earlier.length ? (
              <div className="space-y-2 pt-2">
                <p className="text-caption font-semibold uppercase tracking-wide text-ink-3">Earlier edits</p>
                {earlier.map((p) => (
                  <PatchCard key={p.id} base={base} patchId={p.id} doc={doc} onApplied={onApplied} onUndo={onUndo} disabled={disabled} />
                ))}
              </div>
            ) : null}
          </li>
        ) : (
          turns.map((t) => <TurnView key={t.id} turn={t} workspaceId={workspaceId} base={base} doc={doc} onApplied={onApplied} onUndo={onUndo} onPatchReady={() => void recent.refetch()} disabled={disabled} />)
        )}
      </ul>
      {voice ? (
        <div className="border-t border-line p-3">
          <VoiceRecorder
            appId={appId}
            purpose="voice_command"
            onTranscript={(t) => {
              const v = t.trim();
              setVoice(false);
              if (v) void send(v, scope === "scene" && selectedSceneId ? [selectedSceneId] : [], true);
            }}
          />
        </div>
      ) : null}
      <form
        className="space-y-2 border-t border-line p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <SegmentedControl<"scene" | "all">
          label="Edit scope"
          size="sm"
          value={scope}
          onChange={setScope}
          items={[
            { value: "all", label: "Whole video" },
            { value: "scene", label: sceneName ? `Only ${sceneName}` : "Selected scene", disabled: !selectedSceneId },
          ]}
        />
        <Textarea
          rows={3}
          value={text}
          placeholder="e.g. Show the app recording on an animated iPhone in scene 2"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          aria-label="Edit instruction"
          maxLength={2000}
          disabled={disabled}
        />
        <div className={cn("flex items-center justify-between")}>
          <span className="min-w-0 truncate text-caption text-ink-3">Muse Spark · charged per edit</span>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button type="button" size="sm" variant={voice ? "secondary" : "ghost"} icon={<Mic className="size-4" aria-hidden />} onClick={() => setVoice((v) => !v)} disabled={disabled} aria-pressed={voice}>
              {voice ? "Close" : "Speak"}
            </Button>
            <Button type="submit" size="sm" icon={<Sparkles className="size-4" aria-hidden />} loading={sending} disabled={disabled || !text.trim()}>
              Edit
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
