"use client";
/**
 * Create: "What would you like to make?"
 *
 *   Promote my app / Show a feature / Use a suggested idea → the prompt (a suggestion from About your
 *   app, a feature, or a sourced idea; always editable) → Make a Video · Post · Carousel · More
 *   (Thumbnail, App Store / Google Play screenshots, Text post) and what that needs (format and
 *   length; where it goes, shape, slides; the store) → "Generate carousel" with the real credit
 *   estimate → one finished, editable piece (runs.tsx: the server's run, with plain progress and any
 *   decision inline; progress.tsx: the finished video, slides or post) → Your content.
 *
 * Deep links: ?kind=promote|feature|idea&prompt=…&idea=<opportunity id>&make=<format>&store=ios|android
 * (routes.app().create()). Nothing is posted from here: "Schedule post" drafts a post that waits for approval.
 */
import type { AppDnaResponse, CreateCampaignResponse, CreditsResponse, Page } from "@/lib/api-types";
import type { Channel, Composition, MediaAsset, StoreTarget } from "@muselaunch/contracts";
import { Button, Dialog, Notice, Skeleton, cn, useToast } from "@muselaunch/ui";
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
import { CostLine, FeatureChips, FormatSelect, GenerateButton, KindChoices, LengthSelect, MakeChoice, PromptBox, ShapeSelect, SlidesSelect, StoreSelect, ThumbnailInfo, WhereSelect } from "./form";
import { IdeaPicker } from "./ideas";
import {
  MIN_PROMPT,
  campaignRequest,
  channelFor,
  channelsFor,
  clampLength,
  defaultFormat,
  defaultWhere,
  estimateSteps,
  featurePrompt,
  finishedContent,
  finishedStills,
  finishedTexts,
  finishedVideos,
  formatById,
  generateLabel,
  hasRealFootage,
  ideaPrompt,
  isSlideSet,
  lengthOptions,
  makeNoun,
  promotePrompt,
  screensHint,
  slideOptions,
  sumCredits,
  type ContentItem,
  type CreateKind,
  type CreatePrefill,
  type FormatId,
  type MakeFormat,
  type Shape,
} from "./plan";
import { RunPanel } from "./progress";
import { useCreateRuns } from "./runs";
import { SchedulePostDialog, type ScheduleTarget } from "./schedule";

const placeholder = (kind: CreateKind, noun: string) =>
  kind === "promote" ? `Describe the ${noun} you want…` : kind === "feature" ? "Pick a feature above, or describe one…" : "Pick an idea below, or describe your own…";

const COST_NOTE: Partial<Record<MakeFormat, string>> = {
  text_post: "Credits are held when a step starts and only what’s used is charged. Muse writes the post and checks it against your facts; nothing is rendered.",
};
const STILLS_NOTE = "Credits are held when a step starts and only what’s used is charged. The preview and the brand check are free. The final images cost 1 credit per 4 slides.";

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
  const [make, setMake] = useState<MakeFormat>(prefill.make ?? "video");
  const [store, setStore] = useState<StoreTarget>(prefill.store ?? "ios");
  const [where, setWhere] = useState<Channel>(() => defaultWhere(prefill.make ?? "post", app?.postTo?.channels));
  const [shape, setShape] = useState<Shape>("4:5");
  const [slides, setSlides] = useState<number>(6);
  const [formatId, setFormatId] = useState<FormatId>(() => defaultFormat(app?.postTo?.channels).id);
  const [length, setLength] = useState<number>(20);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(prefill.runId);
  const [postFor, setPostFor] = useState<ScheduleTarget | null>(null);
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
  const noun = makeNoun(make).noun;
  const slideOpts = slideOptions(make, store);
  const slideCount = slideOpts.length ? Math.min(Math.max(slides, slideOpts[0]!), slideOpts.at(-1)!) : 1;

  // The suggestion for the chosen starting point (fills the prompt until the person writes their own).
  const suggestion =
    kind === "promote" ? promotePrompt(appName, { oneLiner: profile?.oneLiner, tagline: app?.tagline }) : kind === "feature" && feature ? featurePrompt(feature) : kind === "idea" && idea ? ideaPrompt(idea) : "";
  useEffect(() => {
    if (!touched && suggestion !== prompt) setPrompt(suggestion);
  }, [suggestion, touched]); // eslint-disable-line react-hooks/exhaustive-deps -- only when the suggestion changes

  // ---- the real estimate (the operations the jobs reserve)
  const aiVoice = workspace?.settings.sound?.aiVoiceover !== false;
  const steps = estimateSteps(lengthSec, { aiVoice, make, slides: slideCount, store });
  // A step the server reserves at a fixed amount (the still final render) shows that amount; the rest ask POST /estimate.
  const estimates = useQueries({
    queries: steps.map((s) => ({
      queryKey: ["estimate", workspaceId, s.operation, s.params],
      queryFn: () => fetchEstimate(workspaceId, { operation: s.operation, params: s.params }),
      staleTime: 60_000,
      retry: false,
      enabled: s.amount === undefined,
    })),
  });
  const lines = steps.flatMap((s, i) => (s.amount !== undefined ? [{ label: s.label, credits: s.amount }] : estimates[i]?.data ? [{ label: s.label, credits: estimates[i]!.data!.credits }] : []));
  const total = lines.length === steps.length ? sumCredits(lines) : null;
  const available = estimates.find((e) => e.data)?.data?.available ?? credits?.available ?? null;
  const short = total !== null && available !== null && total > available;

  // ---- what stops Generate (said plainly, with the way forward)
  const footageKnown = !shots.isLoading && !walk.loading;
  const footage = hasRealFootage([...(shots.data?.items ?? []), ...walk.recordings]);
  const realScreens = (shots.data?.items ?? []).filter((a) => a.isProductTruth && a.role === "screenshot" && (a.status === "ready" || a.status === "uploaded")).length;
  // A text post shows no screens, so it doesn't need them.
  const needsFootage = make !== "text_post";
  const dnaMissing = !dna.isLoading && !profile;
  const learning = app?.status === "importing" || app?.dnaStatus === "drafting";
  const blocked = !canWrite || dnaMissing || (needsFootage && footageKnown && !footage);
  const storeHint = make === "store_screenshots" && !shots.isLoading ? screensHint(realScreens, slideCount) : null;

  // ---- runs and videos
  const titles = useMemo(() => new Map((comps.data?.items ?? []).map((c) => [c.id, c.title])), [comps.data]);
  const videos = useMemo(() => finishedVideos(renders.data?.items ?? [], titles, 12), [renders.data, titles]);
  const stills = useMemo(() => finishedStills(renders.data?.items ?? [], titles, 12), [renders.data, titles]);
  const content = useMemo<ContentItem[]>(() => finishedContent({ videos, stills, texts: finishedTexts(runs.runs) }, 12), [videos, stills, runs.runs]);
  // The run asked for (?run=, e.g. Needs you → Open it), else the newest one still on its way (not one left for later).
  const focus = runs.runs.find((x) => x.campaignId === focusId) ?? (focusId === "none" ? null : runs.runs.find((x) => x.status !== "done" && x.status !== "stopped" && x.decision?.kind !== "resume") ?? null);
  // Keep showing the run being watched once it's ready ("Your video is ready"), until the person closes it.
  useEffect(() => {
    if (focus && focusId !== focus.campaignId && focusId !== "none" && !runs.runs.some((x) => x.campaignId === focusId)) setFocusId(focus.campaignId);
  }, [focusId, focus, runs.runs]);
  const focusVideo = focus?.compositionId ? videos.find((v) => v.compositionId === focus.compositionId) : undefined;
  const focusStills = focus?.compositionId ? stills.find((v) => v.compositionId === focus.compositionId) : undefined;
  const runsById = useMemo(() => new Map(runs.runs.map((x) => [x.campaignId, x])), [runs.runs]);

  const pickMake = (m: MakeFormat, st?: StoreTarget) => {
    setMake(m);
    if (st) setStore(st);
    // Keep where it goes when the new format can go there too.
    const ok = channelsFor(m);
    if (ok.length && !ok.includes(where)) setWhere(defaultWhere(m, app?.postTo?.channels));
  };
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
      setPromptError(kind === "feature" && !feature ? `Pick a feature, or describe the ${noun} in a sentence.` : kind === "idea" && !idea ? `Pick an idea, or describe the ${noun} in a sentence.` : `Describe the ${noun} in a sentence.`);
      promptRef.current?.focus();
      return;
    }
    if (blocked || short || starting) return;
    setStarting(true);
    try {
      const res = await api.post<CreateCampaignResponse>(wsPath(workspaceId, `/apps/${appId}/campaigns`), campaignRequest({ kind, prompt: text, make, format, lengthSec, channel: where, shape, slides: slideCount, store, ideaId: kind === "idea" ? ideaId : null }), { idempotencyKey: idem.current });
      idem.current = newIdempotencyKey("create");
      setFocusId(res.campaign.id);
      // The balance under the button moves with what was just held ("estimate" keys carry it).
      await invalidate(wsPath(workspaceId, `/apps/${appId}/create-runs`), wsPath(workspaceId, `/apps/${appId}/campaigns`), wsPath(workspaceId, "/jobs"), wsPath(workspaceId, "/billing"), wsPath(workspaceId, `/apps/${appId}/discover`), "estimate");
      requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
    } catch (e) {
      idem.current = newIdempotencyKey("create");
      toast.error(`Couldn’t start the ${noun}`, isRouteMissing(e) ? "Create isn’t deployed in this build, so nothing was started." : errorMessage(e));
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
            placeholder={placeholder(kind, noun)}
            label={`Describe your ${noun}`}
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

          <div className="space-y-3 pt-1">
            <MakeChoice value={make} store={make === "store_screenshots" ? store : null} onChange={pickMake} />
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <div className={cn("grid gap-3 sm:flex sm:flex-wrap", make === "video" ? "grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]" : make === "text_post" || make === "thumbnail" ? "grid-cols-1" : "grid-cols-2")}>
                {make === "video" ? (
                  <>
                    <FormatSelect value={formatId} onChange={setFormatId} />
                    <LengthSelect value={lengthSec} options={lengths} onChange={setLength} />
                  </>
                ) : make === "post" ? (
                  <>
                    <WhereSelect value={where} options={channelsFor("post")} onChange={setWhere} />
                    <ShapeSelect value={shape} onChange={setShape} />
                  </>
                ) : make === "carousel" ? (
                  <>
                    <WhereSelect value={where} options={channelsFor("carousel")} onChange={setWhere} className="col-span-2" />
                    <SlidesSelect value={slideCount} options={slideOpts} onChange={setSlides} />
                    <ShapeSelect value={shape} onChange={setShape} />
                  </>
                ) : make === "store_screenshots" ? (
                  <>
                    <StoreSelect value={store} onChange={setStore} />
                    <SlidesSelect value={slideCount} options={slideOpts} onChange={setSlides} />
                  </>
                ) : make === "thumbnail" ? (
                  <ThumbnailInfo />
                ) : (
                  <WhereSelect value={where} options={channelsFor("text_post")} onChange={setWhere} />
                )}
              </div>
              <GenerateButton label={generateLabel(make)} credits={total} loading={starting} disabled={!canWrite || blocked || short || (needsFootage && !footageKnown && !footage)} onClick={() => void generate()} className="w-full sm:ml-auto sm:w-auto" />
            </div>
            {storeHint ? (
              <p className="flex items-start gap-2 text-footnote text-ink-2 text-pretty">
                <MonitorSmartphone className="mt-px size-4 shrink-0 text-ink-3" aria-hidden />
                <span>{storeHint}</span>
              </p>
            ) : null}
          </div>

          {!canWrite ? (
            <Notice icon={<Info aria-hidden />}>You have view access in this workspace. Ask an owner or admin for editor access to make things here.</Notice>
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
              Everything Muse makes only says things that are true about {appName}, so Muse needs to know it first.
            </Notice>
          ) : needsFootage && footageKnown && !footage ? (
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
              There are no screenshots or screen recordings of {appName} yet, and Muse only shows the real app. Add a recording (or a few screenshots on{" "}
              <Link href={r.videos} className="font-medium underline">
                Videos
              </Link>
              ), then make the {noun}.
            </Notice>
          ) : (
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <CostLine lines={lines} total={total} available={available} loading={estimates.some((e) => e.isLoading)} what={noun} note={make === "video" ? undefined : (COST_NOTE[make] ?? STILLS_NOTE)} />
              <p className="text-caption text-ink-3">{make === "text_post" ? "Muse Spark writes it · checked against your facts · nothing is posted without you" : `Muse Spark plans it · HyperFrames renders it · nothing is posted without you`}</p>
            </div>
          )}
          {short ? (
            <p className="text-footnote text-ink-2">
              <Link href={routes.settings.credits(workspaceId)} className="font-medium text-accent hover:underline">
                See credits
              </Link>{" "}
              {make === "video" ? "or pick a shorter length." : isSlideSet(make) ? "or pick fewer slides." : "to add more."}
            </p>
          ) : null}
        </div>
      </div>

      {focus ? (
        <div ref={panelRef} className="relative scroll-mt-24">
          <RunPanel run={focus} finished={focusVideo} stills={focusStills} actions={runs} appId={appId} onSchedule={setPostFor} />
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
        items={content}
        loading={renders.isLoading || runs.loading}
        focusId={focus?.campaignId ?? null}
        onOpenRun={(id) => {
          setFocusId(id);
          requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
        }}
        onPost={setPostFor}
        canPost={canWrite}
      />

      {postFor?.type === "video" ? (
        <NewPostDialog
          appId={appId}
          open
          onOpenChange={(o) => !o && setPostFor(null)}
          initialCampaignId={postFor.campaignId}
          initialAssetId={postFor.assetId}
          initialChannel={channelFor(postFor.campaignId ? runsById.get(postFor.campaignId) : null)}
          onCreated={() =>
            toast.toast({
              title: "Post drafted",
              description: "It waits for approval in Scheduled. Nothing goes out without it.",
              action: { label: "Open Scheduled", onClick: () => router.push(r.scheduled) },
            })
          }
        />
      ) : (
        <SchedulePostDialog appId={appId} target={postFor} channel={postFor?.type === "text" ? postFor.channel : channelFor(postFor?.campaignId ? runsById.get(postFor.campaignId) : null)} onClose={() => setPostFor(null)} />
      )}
      <Dialog open={recordingOpen} onOpenChange={setRecordingOpen} title="Add a screen recording" size="lg" hideTitle>
        <WalkthroughPrompt workspaceId={workspaceId} appId={appId} variant="inline" />
      </Dialog>
    </div>
  );
}
