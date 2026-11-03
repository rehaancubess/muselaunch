"use client";
/**
 * Create: "What would you like to make?"
 *
 *   Promote my app / Show a feature / Use a suggested idea → the prompt (a suggestion from About your
 *   app, a feature, or a sourced idea; always editable) → Format and Length → "Generate video" with
 *   the real credit estimate → one finished, editable video (runs.tsx: the campaign request, the
 *   best-fitting idea, the plan in the chosen format and length, the editable video, the brand check
 *   and the final render, with plain progress and any decision inline) → Your content.
 *
 * Deep links: ?kind=promote|feature|idea&prompt=…&idea=<opportunity id> (routes.app().create()).
 * Nothing is posted from here: "Post it" opens the usual new-post flow, which waits for approval.
 */
import type { AppDnaResponse, CreateCampaignResponse, CreditsResponse, Page } from "@/lib/api-types";
import type { Composition, MediaAsset } from "@muselaunch/contracts";
import { Button, Dialog, Notice, Skeleton, useToast } from "@muselaunch/ui";
import { useQueries } from "@tanstack/react-query";
import { Info, MonitorSmartphone, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FeedResponse, FeedItem } from "@/features/discover/picks";
import { useWalkthroughs, WalkthroughPrompt } from "@/features/media/walkthrough";
import { NewPostDialog } from "@/features/publishing/new-post";
import { api, errorMessage, isRouteMissing, newIdempotencyKey, wsPath } from "@/lib/api";
import { fetchEstimate } from "@/lib/estimate";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { routes } from "@/lib/routes";
import { useCurrentApp, useWorkspace } from "@/lib/workspace";
import { YourContent } from "./content";
import { CostLine, FeatureChips, FormatSelect, GenerateButton, KindChoices, LengthSelect, PromptBox } from "./form";
import { IdeaPicker } from "./ideas";
import {
  MIN_PROMPT,
  campaignRequest,
  channelFor,
  clampLength,
  defaultFormat,
  estimateSteps,
  featurePrompt,
  finishedVideos,
  formatById,
  hasRealFootage,
  ideaPrompt,
  lengthOptions,
  promotePrompt,
  sumCredits,
  type CreateKind,
  type CreatePrefill,
  type FinishedVideo,
  type FormatId,
} from "./plan";
import { RunPanel } from "./progress";
import { useCreateRuns } from "./runs";

const PLACEHOLDER: Record<CreateKind, string> = {
  promote: "Describe the video you want…",
  feature: "Pick a feature above, or describe one…",
  idea: "Pick an idea below, or describe your own…",
};

export function CreatePage({ prefill }: { prefill: CreatePrefill }) {
  const { app, appId, workspaceId } = useCurrentApp();
  const { can, credits, workspace } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const invalidate = useInvalidate();
  const r = routes.app(workspaceId, appId);
  const canWrite = can("content.write");
  const appName = app?.name && app.name !== "New app" ? app.name : "your app";

  // ---- what the person is making
  const [kind, setKind] = useState<CreateKind>(prefill.kind ?? "promote");
  const [prompt, setPrompt] = useState(prefill.prompt);
  /** The person wrote (or kept) their own words: suggestions don't replace them. */
  const [touched, setTouched] = useState(Boolean(prefill.prompt));
  const [featureId, setFeatureId] = useState<string | null>(null);
  const [ideaId, setIdeaId] = useState<string | null>(prefill.ideaId);
  const [formatId, setFormatId] = useState<FormatId>(() => defaultFormat(app?.postTo?.channels).id);
  const [length, setLength] = useState<number>(20);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(prefill.runId);
  const [postFor, setPostFor] = useState<FinishedVideo | null>(null);
  const [recordingOpen, setRecordingOpen] = useState(false);
  const idem = useRef(newIdempotencyKey("create"));
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // ---- what MuseLaunch knows
  const dna = useApiQuery<AppDnaResponse>(wsPath(workspaceId, `/apps/${appId}/dna`), { retry: false, staleTime: 60_000 });
  const plan = useApiQuery<CreditsResponse>(wsPath(workspaceId, "/billing/credits"), { staleTime: 60_000, retry: false });
  const feed = useApiQuery<FeedResponse>(kind === "idea" || prefill.ideaId ? wsPath(workspaceId, `/apps/${appId}/discover/feed`) : null, { query: { limit: 50 }, staleTime: 60_000, retry: false });
  const shots = useApiQuery<Page<MediaAsset>>(wsPath(workspaceId, "/assets"), { query: { appId, role: "screenshot", limit: 20 } });
  const walk = useWalkthroughs(workspaceId, appId);
  const renders = useApiQuery<Page<MediaAsset>>(wsPath(workspaceId, "/assets"), { query: { appId, role: "render", limit: 60 } });
  const comps = useApiQuery<Page<Composition>>(wsPath(workspaceId, "/compositions"), { query: { appId, limit: 100 } });
  const runs = useCreateRuns(appId);

  const profile = dna.data?.profile ?? null;
  const features = useMemo(() => (profile?.features ?? []).filter((f) => f.name.trim()).slice(0, 12), [profile]);
  const feature = features.find((f) => f.id === featureId) ?? null;
  const ideas = useMemo(() => feed.data?.items ?? [], [feed.data]);
  const idea = ideaId ? (ideas.find((i) => i.type === "opportunity" && i.refId === ideaId) ?? null) : null;
  const maxVideoSec = plan.data?.plan.limits.maxVideoSec ?? 60;
  const lengths = lengthOptions(maxVideoSec);
  const lengthSec = clampLength(length, maxVideoSec);
  const format = formatById(formatId);

  // The suggestion for the chosen starting point (fills the prompt until the person writes their own).
  const suggestion =
    kind === "promote" ? promotePrompt(appName, { oneLiner: profile?.oneLiner, tagline: app?.tagline }) : kind === "feature" && feature ? featurePrompt(feature) : kind === "idea" && idea ? ideaPrompt(idea) : "";
  useEffect(() => {
    if (!touched && suggestion !== prompt) setPrompt(suggestion);
  }, [suggestion, touched]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the suggestion changes

  // ---- the real estimate (the operations the jobs reserve)
  const aiVoice = workspace?.settings.sound?.aiVoiceover !== false;
  const steps = estimateSteps(lengthSec, { aiVoice });
  const estimates = useQueries({
    queries: steps.map((s) => ({
      queryKey: ["estimate", workspaceId, s.operation, s.params],
      queryFn: () => fetchEstimate(workspaceId, { operation: s.operation, params: s.params }),
      staleTime: 60_000,
      retry: false,
    })),
  });
  const lines = steps.flatMap((s, i) => (estimates[i]?.data ? [{ label: s.label, credits: estimates[i]!.data!.credits }] : []));
  const total = lines.length === steps.length ? sumCredits(lines) : null;
  const available = estimates.find((e) => e.data)?.data?.available ?? credits?.available ?? null;
  const short = total !== null && available !== null && total > available;

  // ---- what stops Generate (said plainly, with the way forward)
  const footageKnown = !shots.isLoading && !walk.loading;
  const footage = hasRealFootage([...(shots.data?.items ?? []), ...walk.recordings]);
  const dnaMissing = !dna.isLoading && !profile;
  const learning = app?.status === "importing" || app?.dnaStatus === "drafting";
  const blocked = !canWrite || dnaMissing || (footageKnown && !footage);

  // ---- runs and videos
  const titles = useMemo(() => new Map((comps.data?.items ?? []).map((c) => [c.id, c.title])), [comps.data]);
  const videos = useMemo(() => finishedVideos(renders.data?.items ?? [], titles, 12), [renders.data, titles]);
  // The run asked for (?run=, e.g. Needs you → Open it), else the newest one still on its way (not one left for later).
  const focus = runs.runs.find((x) => x.campaignId === focusId) ?? (focusId === "none" ? null : runs.runs.find((x) => x.status !== "done" && x.status !== "stopped" && x.decision?.kind !== "resume") ?? null);
  // Keep showing the run being watched once it's ready ("Your video is ready"), until the person closes it.
  useEffect(() => {
    if (focus && focusId !== focus.campaignId && focusId !== "none" && !runs.runs.some((x) => x.campaignId === focusId)) setFocusId(focus.campaignId);
  }, [focusId, focus, runs.runs]);
  const focusVideo = focus?.compositionId ? videos.find((v) => v.compositionId === focus.compositionId) : undefined;
  const runsById = useMemo(() => new Map(runs.runs.map((x) => [x.campaignId, x])), [runs.runs]);

  const pickKind = (k: CreateKind) => {
    setKind(k);
    setPromptError(null);
    const next = k === "promote" ? true : k === "feature" ? Boolean(feature) : Boolean(idea);
    // A starting point with its own suggestion fills the prompt; otherwise the person's words stay.
    if (next || !touched) setTouched(false);
  };
  const pickFeature = (id: string) => {
    setFeatureId(id);
    setTouched(false);
    setPromptError(null);
  };
  const pickIdea = (item: FeedItem) => {
    setIdeaId(item.refId);
    setTouched(false);
    setPromptError(null);
    promptRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const generate = async () => {
    const text = prompt.trim();
    if (text.length < MIN_PROMPT) {
      setPromptError(kind === "feature" && !feature ? "Pick a feature, or describe the video in a sentence." : kind === "idea" && !idea ? "Pick an idea, or describe the video in a sentence." : "Describe the video in a sentence.");
      promptRef.current?.focus();
      return;
    }
    if (blocked || short || starting) return;
    setStarting(true);
    try {
      const res = await api.post<CreateCampaignResponse>(wsPath(workspaceId, `/apps/${appId}/campaigns`), campaignRequest({ kind, prompt: text, format, lengthSec, ideaId: kind === "idea" ? ideaId : null }), { idempotencyKey: idem.current });
      idem.current = newIdempotencyKey("create");
      setFocusId(res.campaign.id);
      // The balance under the button moves with what was just held ("estimate" keys carry it).
      await invalidate(wsPath(workspaceId, `/apps/${appId}/create-runs`), wsPath(workspaceId, `/apps/${appId}/campaigns`), wsPath(workspaceId, "/jobs"), wsPath(workspaceId, "/billing"), wsPath(workspaceId, `/apps/${appId}/discover`), "estimate");
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      idem.current = newIdempotencyKey("create");
      toast.error("Couldn’t start the video", isRouteMissing(e) ? "Video generation isn’t deployed in this build, so nothing was started." : errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="space-y-10 md:space-y-12">
      <div className="space-y-5">
        <h1 className="text-title-2 font-semibold text-ink text-balance md:text-title-1">What would you like to make?</h1>
        <KindChoices value={kind} onChange={pickKind} />

        {kind === "feature" ? (
          dna.isLoading ? (
            <Skeleton className="h-11 w-full max-w-lg" rounded="full" />
          ) : features.length ? (
            <FeatureChips features={features} value={featureId} onPick={pickFeature} />
          ) : (
            <p className="text-footnote text-ink-2">
              No features listed for {appName} yet.{" "}
              <Link href={r.about} className="font-medium text-accent hover:underline">
                Add them in About your app
              </Link>
              , or describe the feature below.
            </p>
          )
        ) : null}

        <div className="space-y-3">
          <PromptBox
            value={prompt}
            onChange={(v) => {
              setPrompt(v);
              setTouched(true);
              if (promptError) setPromptError(null);
            }}
            onSubmit={() => void generate()}
            placeholder={PLACEHOLDER[kind]}
            invalid={Boolean(promptError)}
            describedBy={promptError ? "create-prompt-error" : undefined}
            inputRef={promptRef}
          />
          {promptError ? (
            <p id="create-prompt-error" className="text-footnote text-danger">
              {promptError}
            </p>
          ) : null}
          {kind === "idea" && idea ? (
            <p className="flex flex-wrap items-center gap-x-1.5 text-footnote text-ink-2">
              <span>
                Using the idea <span className="font-medium text-ink">“{idea.title}”</span>
              </span>
              <button type="button" onClick={() => (setIdeaId(null), setTouched(true))} className="inline-flex min-h-11 items-center gap-1 font-medium text-accent hover:underline sm:min-h-0">
                <X className="size-3.5" aria-hidden />
                Don’t use it
              </button>
            </p>
          ) : null}

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="grid grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] gap-3 sm:flex">
              <FormatSelect value={formatId} onChange={setFormatId} />
              <LengthSelect value={lengthSec} options={lengths} onChange={setLength} />
            </div>
            <GenerateButton credits={total} loading={starting} disabled={!canWrite || blocked || short || (!footageKnown && !footage)} onClick={() => void generate()} className="w-full sm:ml-auto sm:w-auto" />
          </div>

          {!canWrite ? (
            <Notice icon={<Info aria-hidden />}>You have view access in this workspace. Ask an owner or admin for editor access to make videos.</Notice>
          ) : dnaMissing ? (
            <Notice
              tone="info"
              icon={<Info aria-hidden />}
              title={learning ? "Muse is still learning about your app" : "Tell Muse about your app first"}
              action={
                <Button size="sm" variant="secondary" asChild>
                  <Link href={r.about}>{learning ? "See progress" : "Open About your app"}</Link>
                </Button>
              }
            >
              Videos only say things that are true about {appName}, so Muse needs to know it first.
            </Notice>
          ) : footageKnown && !footage ? (
            <Notice
              tone="info"
              icon={<MonitorSmartphone aria-hidden />}
              title="Muse needs to see your real app first"
              action={
                <Button size="sm" onClick={() => setRecordingOpen(true)}>
                  Add a screen recording
                </Button>
              }
            >
              There are no screenshots or screen recordings of {appName} yet, and videos only show the real app. Add a recording (or a few screenshots on{" "}
              <Link href={r.videos} className="font-medium underline">
                Videos
              </Link>
              ), then make the video.
            </Notice>
          ) : (
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <CostLine lines={lines} total={total} available={available} loading={estimates.some((e) => e.isLoading)} />
              <p className="text-caption text-ink-3">Muse Spark plans it · HyperFrames renders it · nothing is posted without you</p>
            </div>
          )}
          {short ? (
            <p className="text-footnote text-ink-2">
              <Link href={routes.settings.credits(workspaceId)} className="font-medium text-accent hover:underline">
                See credits
              </Link>{" "}
              or pick a shorter length.
            </p>
          ) : null}
        </div>
      </div>

      {focus ? (
        <div ref={panelRef} className="relative scroll-mt-24">
          <RunPanel run={focus} finished={focusVideo} actions={runs} appId={appId} onPost={setPostFor} />
          {focus.status === "done" ? (
            <button type="button" aria-label="Close" onClick={() => setFocusId("none")} className="absolute right-2 top-2 flex size-11 items-center justify-center rounded-full text-ink-3 hover:bg-mist hover:text-ink focus-visible:outline-none focus-visible:shadow-focus">
              <X className="size-4" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : (
        <div ref={panelRef} />
      )}

      {kind === "idea" ? <IdeaPicker appId={appId} items={ideas} loading={feed.isLoading} error={feed.error} selectedId={ideaId} onPick={pickIdea} /> : null}

      <YourContent
        appId={appId}
        runs={runs.runs}
        videos={videos}
        loading={renders.isLoading || runs.loading}
        focusId={focus?.campaignId ?? null}
        onOpenRun={(id) => {
          setFocusId(id);
          requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }}
        onPost={setPostFor}
        canPost={canWrite}
      />

      <NewPostDialog
        appId={appId}
        open={Boolean(postFor)}
        onOpenChange={(o) => !o && setPostFor(null)}
        initialCampaignId={postFor?.campaignId}
        initialAssetId={postFor?.assetId}
        initialChannel={channelFor(postFor?.campaignId ? runsById.get(postFor.campaignId) : null)}
        onCreated={() =>
          toast.toast({
            title: "Post drafted",
            description: "It waits for approval in Scheduled. Nothing goes out without it.",
            action: { label: "Open Scheduled", onClick: () => router.push(r.scheduled) },
          })
        }
      />
      <Dialog open={recordingOpen} onOpenChange={setRecordingOpen} title="Add a screen recording" size="lg" hideTitle>
        <WalkthroughPrompt workspaceId={workspaceId} appId={appId} variant="inline" />
      </Dialog>
    </div>
  );
}
