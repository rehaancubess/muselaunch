/**
 * Create: "What would you like to make?" Promote my app / Show a feature / Use a suggested idea →
 * the prompt (a suggestion, always editable; typed or said) → what to make (a video, a post, a
 * carousel, a thumbnail, store screenshots or a text post) and its options → "Generate …"
 * with the real credit estimate → the same campaign request as the web's Create page
 * (POST /apps/:appId/campaigns, origin "create"). MuseLaunch carries it to the finished video; this
 * screen shows where it stands. Nothing is posted from here.
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Megaphone, Sparkle, SquarePlay } from "lucide-react-native";
import { useEffect, useMemo, useRef, useState, type ComponentRef } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { can, errorMessage, newKey } from "../../api/client";
import type { AppDnaResponse, CreditsResponse, EstimateResponse, FeedItem, FeedResponse, MediaAsset, Page } from "../../api/types";
import { RunsSection, useCreateRuns } from "../../features/create/runs";
import { AppHeader } from "../../features/header";
import { HoldToTalk } from "../../features/voice/hold-to-talk";
import {
  CREATE_KINDS,
  FORMATS,
  KIND_LABEL,
  MAKES,
  MIN_PROMPT,
  campaignRequest,
  clampLength,
  clampSlideCount,
  defaultFormat,
  estimateSteps,
  featurePrompt,
  formatById,
  hasRealFootage,
  ideaPrompt,
  lengthOptions,
  makeById,
  primarySource,
  promotePrompt,
  siteName,
  stillCampaignRequest,
  stillEstimateSteps,
  sumCredits,
  topIdeas,
  type CreateKind,
  type FormatId,
  type MakeId,
} from "../../lib/plan";
import { channelLabel } from "../../lib/home-lines";
import type { Channel } from "../../api/types";
import { fullNumber } from "../../lib/results-lines";
import { useSession } from "../../session";
import { Button, Chip, Field, Notice, T } from "../../ui/components";
import { color, radius, space } from "../../ui/theme";
import { useToast } from "../../ui/toast";
import { useAccent } from "../../ui/accent";

const KIND_ICON = { promote: Megaphone, feature: SquarePlay, idea: Sparkle } as const;
const PLACEHOLDER: Record<CreateKind, string> = { promote: "Describe what you want to make…", feature: "Pick a feature above, or describe one…", idea: "Pick an idea below, or describe your own…" };

export default function CreateScreen() {
  const ac = useAccent();
  const kindOn = { borderColor: ac.accent, backgroundColor: ac.accentSoft };
  const { api, app, appId, workspaceId, workspace, member } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const appName = app?.name && app.name !== "New app" ? app.name : "your app";
  const canWrite = can(member, "content.write");

  const [kind, setKind] = useState<CreateKind>("promote");
  const [prompt, setPrompt] = useState("");
  const [touched, setTouched] = useState(false);
  const [spoken, setSpoken] = useState(false);
  const [featureId, setFeatureId] = useState<string | null>(null);
  const [ideaId, setIdeaId] = useState<string | null>(null);
  const [formatId, setFormatId] = useState<FormatId>(() => defaultFormat(app?.postTo?.channels).id);
  const [formatPicked, setFormatPicked] = useState(false);
  // The first place the person said they post, once the app has loaded (until they pick a format).
  useEffect(() => {
    if (!formatPicked) setFormatId(defaultFormat(app?.postTo?.channels).id);
  }, [app?.id, app?.postTo?.channels, formatPicked]);
  const [length, setLength] = useState(20);
  const [makeId, setMakeId] = useState<MakeId>("video");
  const make = makeById(makeId);
  const isVideo = make.id === "video";
  const [where, setWhere] = useState<Channel | null>(null);
  const channel: Channel = where && make.channels.includes(where) ? where : (make.channels[0] ?? "instagram");
  const [slideCount, setSlideCount] = useState<number | null>(null);
  const slides = clampSlideCount(make, slideCount);
  const [promptError, setPromptError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const idem = useRef(newKey("create"));

  const enabled = Boolean(workspaceId && appId);
  const dna = useQuery({ queryKey: ["dna", workspaceId, appId], queryFn: () => api.get<AppDnaResponse>(api.ws(`/apps/${appId}/dna`)), enabled, staleTime: 60_000, retry: false });
  const credits = useQuery({ queryKey: ["credits", workspaceId], queryFn: () => api.get<CreditsResponse>(api.ws("/billing/credits")), enabled, staleTime: 60_000, retry: false });
  const feed = useQuery({ queryKey: ["feed", workspaceId, appId], queryFn: () => api.get<FeedResponse>(api.ws(`/apps/${appId}/discover/feed`), { limit: 50 }), enabled: enabled && kind === "idea", staleTime: 60_000, retry: false });
  const shots = useQuery({ queryKey: ["assets", workspaceId, appId, "screenshot"], queryFn: () => api.get<Page<MediaAsset>>(api.ws("/assets"), { appId, role: "screenshot", limit: 20 }), enabled });
  const recs = useQuery({ queryKey: ["assets", workspaceId, appId, "app_recording"], queryFn: () => api.get<Page<MediaAsset>>(api.ws("/assets"), { appId, role: "app_recording", limit: 20 }), enabled });
  const runs = useCreateRuns();

  const profile = dna.data?.profile ?? null;
  const features = useMemo(() => (profile?.features ?? []).filter((f) => f.name.trim()).slice(0, 12), [profile]);
  const feature = features.find((f) => f.id === featureId) ?? null;
  const ideas = useMemo(() => topIdeas(feed.data?.items ?? [], 3), [feed.data]);
  const idea: FeedItem | null = ideaId ? ((feed.data?.items ?? []).find((i) => i.type === "opportunity" && i.refId === ideaId) ?? null) : null;
  const maxVideoSec = credits.data?.plan.limits.maxVideoSec ?? 60;
  const lengths = lengthOptions(maxVideoSec);
  const lengthSec = clampLength(length, maxVideoSec);
  const format = formatById(formatId);

  const suggestion = kind === "promote" ? promotePrompt(appName, { oneLiner: profile?.oneLiner, tagline: app?.tagline }) : kind === "feature" && feature ? featurePrompt(feature) : kind === "idea" && idea ? ideaPrompt(idea) : "";
  useEffect(() => {
    if (!touched && suggestion !== prompt) setPrompt(suggestion);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when the suggestion changes
  }, [suggestion, touched]);

  // The real estimate: the operations the run's jobs reserve (POST /estimate each), like the web.
  const aiVoice = workspace?.settings.sound?.aiVoiceover !== false;
  const steps = isVideo ? estimateSteps(lengthSec, { aiVoice }) : stillEstimateSteps(make, slides);
  const estimates = useQueries({
    queries: steps.map((s) => ({ queryKey: ["estimate", workspaceId, s.operation, s.params], queryFn: () => api.post<EstimateResponse>(api.ws("/estimate"), { operation: s.operation, params: s.params }), enabled, staleTime: 60_000, retry: false })),
  });
  const lines = steps.flatMap((s, i) => (estimates[i]?.data ? [{ label: s.label, credits: estimates[i]!.data!.credits }] : []));
  const total = lines.length === steps.length ? sumCredits(lines) : null;
  const available = estimates.find((e) => e.data)?.data?.available ?? credits.data?.balance.available ?? null;
  const short = total !== null && available !== null && total > available;

  const footageKnown = !shots.isLoading && !recs.isLoading;
  const footage = hasRealFootage([...(shots.data?.items ?? []), ...(recs.data?.items ?? [])]);
  const dnaMissing = !dna.isLoading && !profile;
  // A text post needs no screens; everything else shows the real app.
  const needsFootage = make.id !== "text_post";
  const blocked = !canWrite || dnaMissing || (needsFootage && footageKnown && !footage);
  const realScreens = (shots.data?.items ?? []).filter((a) => a.isProductTruth && a.status === "ready").length;
  const fewScreens = (make.id === "app_store" || make.id === "google_play") && footageKnown && realScreens > 0 && realScreens < slides;

  const pickKind = (k: CreateKind) => {
    setKind(k);
    setPromptError(null);
    const has = k === "promote" ? true : k === "feature" ? Boolean(feature) : Boolean(idea);
    if (has || !touched) setTouched(false);
  };

  const generate = async () => {
    const text = prompt.trim();
    if (text.length < MIN_PROMPT) {
      setPromptError(kind === "feature" && !feature ? `Pick a feature, or describe the ${make.noun} in a sentence.` : kind === "idea" && !idea ? `Pick an idea, or describe the ${make.noun} in a sentence.` : `Describe the ${make.noun} in a sentence.`);
      return;
    }
    if (blocked || short || starting) return;
    setStarting(true);
    try {
      const body = isVideo ? campaignRequest({ kind, prompt: text, format, lengthSec, ideaId: kind === "idea" ? ideaId : null }) : stillCampaignRequest({ kind, prompt: text, make, channel, slides, ideaId: kind === "idea" ? ideaId : null });
      await api.post(api.ws(`/apps/${appId}/campaigns`), body, { idempotencyKey: idem.current });
      idem.current = newKey("create");
      toast({ title: make.id === "text_post" ? "Muse is writing your post" : make.noun === "screenshots" ? "Muse is making your screenshots" : `Muse is making your ${make.noun}`, body: "You can close the app: it carries on, and nothing is posted without your OK." });
      await Promise.all([qc.invalidateQueries({ queryKey: ["create-runs"] }), qc.invalidateQueries({ queryKey: ["campaigns"] }), qc.invalidateQueries({ queryKey: ["jobs"] }), qc.invalidateQueries({ queryKey: ["estimate"] }), qc.invalidateQueries({ queryKey: ["credits"] })]);
      setTimeout(() => scroll.current?.scrollToEnd({ animated: true }), 400);
    } catch (e) {
      idem.current = newKey("create");
      toast({ title: `Couldn’t start the ${make.noun}`, body: errorMessage(e), tone: "error" });
    } finally {
      setStarting(false);
    }
  };

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: color.canvas }}>
      <AppHeader />
      <ScrollView ref={scroll} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: space.gutter, gap: 22, paddingBottom: 48 }} refreshControl={<RefreshControl refreshing={false} onRefresh={() => void runs.refetch()} tintColor={ac.accent} />}>
        <T v="title1" accessibilityRole="header">
          What would you like to make?
        </T>

        <View style={{ gap: 10 }}>
          {CREATE_KINDS.map((k) => {
            const Icon = KIND_ICON[k];
            const on = kind === k;
            return (
              <Pressable key={k} onPress={() => pickKind(k)} accessibilityRole="radio" accessibilityState={{ checked: on }} style={({ pressed }) => [styles.kind, on && kindOn, pressed && !on && { backgroundColor: color.mist }]}>
                <Icon size={22} color={on ? ac.accent : color.ink} strokeWidth={1.8} />
                <T v="body" style={{ flex: 1, fontWeight: "600", color: on ? ac.accentInk : color.ink }}>
                  {KIND_LABEL[k]}
                </T>
                {on ? (
                  <View style={[styles.check, { backgroundColor: ac.accent }]}>
                    <Check size={13} color={color.white} strokeWidth={3} />
                  </View>
                ) : null}
              </Pressable>
            );
          })}
        </View>

        {kind === "feature" ? (
          features.length ? (
            <View style={styles.wrap}>
              {features.map((f) => (
                <Chip
                  key={f.id}
                  label={f.name}
                  selected={f.id === featureId}
                  onPress={() => {
                    setFeatureId(f.id);
                    setTouched(false);
                    setPromptError(null);
                  }}
                />
              ))}
            </View>
          ) : !dna.isLoading ? (
            <T v="footnote">{`No features listed for ${appName} yet. Add them in About your app on the web, or describe the feature below.`}</T>
          ) : null
        ) : null}

        {kind === "idea" ? (
          <View style={{ gap: 10 }}>
            <T v="footnote">Ideas Muse found for your app. Each shows where Muse found it.</T>
            {feed.isLoading ? (
              <T v="footnote">Loading ideas…</T>
            ) : ideas.length ? (
              ideas.map((i) => {
                const src = primarySource(i);
                const on = i.refId === ideaId;
                return (
                  <Pressable
                    key={i.id}
                    onPress={() => {
                      setIdeaId(on ? null : i.refId);
                      setTouched(false);
                      setPromptError(null);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: on }}
                    style={({ pressed }) => [styles.idea, on && kindOn, pressed && !on && { backgroundColor: color.mist }]}
                  >
                    <T v="bodySm" style={{ fontWeight: "600" }} numberOfLines={2}>
                      {i.title}
                    </T>
                    {src ? <T v="caption">{`Source: ${siteName(src)}`}</T> : null}
                  </Pressable>
                );
              })
            ) : (
              <Notice>No ideas with a source yet. Tap Look again in Discover on the web and Muse checks what’s working for apps like yours.</Notice>
            )}
          </View>
        ) : null}

        <View style={{ gap: 10 }}>
          <Field
            value={prompt}
            onChangeText={(t) => {
              setPrompt(t);
              setTouched(true);
              setSpoken(false);
              if (promptError) setPromptError(null);
            }}
            placeholder={PLACEHOLDER[kind]}
            multiline
            maxLength={4000}
            invalid={Boolean(promptError)}
            editable={!voiceBusy}
            accessibilityLabel={`Describe the ${make.noun}`}
          />
          {promptError ? <T v="footnote" style={{ color: color.danger }}>{promptError}</T> : spoken ? <T v="caption">{`From what you said. Check it, then tap Generate ${make.noun}.`}</T> : null}
          <HoldToTalk
            onBusyChange={setVoiceBusy}
            onText={(t) => {
              setPrompt(t);
              setTouched(true);
              setSpoken(true);
              setPromptError(null);
            }}
          />
        </View>

        <View style={{ gap: 10 }}>
          <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>
            Make a…
          </T>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
            {MAKES.map((m) => (
              <Chip key={m.id} label={m.label} selected={m.id === makeId} onPress={() => setMakeId(m.id)} />
            ))}
          </ScrollView>
        </View>

        {!isVideo ? (
          <View style={{ gap: 10 }}>
            {make.channels.length > 1 ? (
              <>
                <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>
                  Where
                </T>
                <View style={styles.wrap}>
                  {make.channels.map((c) => (
                    <Chip key={c} label={channelLabel(c)} selected={c === channel} onPress={() => setWhere(c)} />
                  ))}
                </View>
              </>
            ) : null}
            {make.slides ? (
              <>
                <T v="footnote" style={{ fontWeight: "600", color: color.ink, marginTop: make.channels.length > 1 ? 4 : 0 }}>
                  Slides
                </T>
                <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
                  {Array.from({ length: make.slides.max - make.slides.min + 1 }, (_, i) => make.slides!.min + i).map((n) => (
                    <Chip key={n} label={String(n)} selected={n === slides} onPress={() => setSlideCount(n)} />
                  ))}
                </ScrollView>
              </>
            ) : null}
            <T v="caption">
              {make.id === "post"
                ? "One image, 4:5, with your real app screen."
                : make.id === "carousel"
                  ? `${slides} slides, 4:5: a cover, one idea per slide, and an ending.${channel === "instagram" ? " Instagram takes up to 10." : ""}`
                  : make.id === "thumbnail"
                    ? "A YouTube thumbnail, 1920×1080, a few bold words."
                    : make.id === "app_store"
                      ? `${slides} App Store screenshots, 1290×2796, each a real screen of your app.`
                      : make.id === "google_play"
                        ? `${slides} Google Play screenshots, 1080×1920, each a real screen of your app.`
                        : `Written for ${channelLabel(channel)}${channel === "x" ? ", 280 characters at most" : ""}, and checked against your app’s facts.`}
            </T>
            {fewScreens ? <Notice tone="accent">{`${appName} has ${realScreens} real screenshot${realScreens === 1 ? "" : "s"}. Muse only uses real screens, so the set may have fewer slides. Add more on the web.`}</Notice> : null}
          </View>
        ) : null}

        {isVideo ? (
          <View style={{ gap: 10 }}>
            <T v="footnote" style={{ fontWeight: "600", color: color.ink }}>
              Format
            </T>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
              {FORMATS.map((f) => (
                <Chip
                  key={f.id}
                  label={`${f.label} · ${f.aspectRatio}`}
                  selected={f.id === formatId}
                  onPress={() => {
                    setFormatId(f.id);
                    setFormatPicked(true);
                  }}
                />
              ))}
            </ScrollView>
            <T v="footnote" style={{ fontWeight: "600", color: color.ink, marginTop: 4 }}>
              Length
            </T>
            <View style={styles.wrap}>
              {lengths.map((s) => (
                <Chip key={s} label={`${s} seconds`} selected={s === lengthSec} onPress={() => setLength(s)} />
              ))}
            </View>
          </View>
        ) : null}

        {!canWrite ? (
          <Notice>You have view access in this workspace. Ask an owner or admin for editor access to make content.</Notice>
        ) : dnaMissing ? (
          <Notice tone="accent">{`Tell Muse about ${appName} first (About your app, on the web): Muse only says things that are true about it.`}</Notice>
        ) : needsFootage && footageKnown && !footage ? (
          <Notice tone="accent">{`Muse needs to see your real app first. Add a screen recording or a few screenshots of ${appName} on the web, then make the ${make.noun} here.`}</Notice>
        ) : null}

        <View style={{ gap: 8 }}>
          <Button
            title={starting ? "Starting…" : `Generate ${make.noun}`}
            onPress={() => void generate()}
            loading={starting}
            disabled={blocked || short || voiceBusy || (needsFootage && !footageKnown && !footage)}
            trailing={
              total !== null ? (
                <View style={styles.credits}>
                  <T v="caption" style={{ color: color.white, fontWeight: "600" }}>{`${fullNumber(total)} credits`}</T>
                </View>
              ) : null
            }
          />
          <T v="caption" style={{ textAlign: "center" }}>
            {total === null
              ? estimates.some((e) => e.isLoading)
                ? "Checking the cost…"
                : "The cost shows here before anything runs."
              : `About ${fullNumber(total)} credits${available !== null ? ` · ${fullNumber(Math.max(0, available))} available` : ""}${aiVoice && isVideo ? " · AI voice only if the video has narration" : ""}`}
          </T>
          {short ? <Notice tone="warning">{isVideo ? "Not enough credits for this length. Pick a shorter one, or add credits on the web." : make.slides ? "Not enough credits for this many slides. Pick fewer, or add credits on the web." : "Not enough credits for this. Add credits on the web."}</Notice> : null}
          <T v="caption" style={{ textAlign: "center" }}>
            {make.id === "text_post" ? "Muse Spark writes it · checked against your facts · nothing is posted without you" : "Muse Spark plans it · HyperFrames renders it · nothing is posted without you"}
          </T>
        </View>

        <RunsSection runs={runs.runs} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  kind: { flexDirection: "row", alignItems: "center", gap: 14, minHeight: 60, paddingHorizontal: 16, borderRadius: radius.xl, borderWidth: 1, borderColor: color.line, backgroundColor: color.surface },
  check: { width: 22, height: 22, borderRadius: 11, alignItems: "center", justifyContent: "center" },
  wrap: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  idea: { gap: 4, padding: 14, borderRadius: radius.lg, borderWidth: 1, borderColor: color.line, backgroundColor: color.surface },
  credits: { marginLeft: 4, paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: "rgba(255,255,255,0.22)" },
});
