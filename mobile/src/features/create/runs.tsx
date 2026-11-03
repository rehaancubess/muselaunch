/**
 * Create runs on the phone: the videos "Generate video" started (campaigns with origin "create",
 * the last week), where each stands (lib/plan.ts runView, from stored records only) and the finished
 * video when it's there. The phone never takes a run's steps itself.
 */
import { useQueries, useQuery } from "@tanstack/react-query";
import { Check, Play } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { Campaign, CampaignDetailResponse, Job, MediaAsset, Page } from "../../api/types";
import { firstSentence, runLine, runView, STEP_LABEL, STEPS, stepState, type RunView } from "../../lib/plan";
import { useSession } from "../../session";
import { Card, ProgressBar, SectionTitle, Spinner, T } from "../../ui/components";
import { color } from "../../ui/theme";
import { VideoModal } from "../home/post-video";
import { useAccent } from "../../ui/accent";

const FOLLOW_MS = 7 * 86_400_000;
const MAX_FOLLOWED = 4;

export interface CreateRun {
  campaign: Campaign;
  view: RunView;
}

export function useCreateRuns() {
  const { api, appId, workspaceId } = useSession();
  const list = useQuery({ queryKey: ["campaigns", workspaceId, appId], queryFn: () => api.get<Page<Campaign>>(api.ws(`/apps/${appId}/campaigns`)), enabled: Boolean(appId && workspaceId), staleTime: 10_000 });
  const followed = useMemo(() => (list.data?.items ?? []).filter((c) => c.origin === "create" && c.status !== "archived" && Date.now() - Date.parse(c.createdAt) < FOLLOW_MS).slice(0, MAX_FOLLOWED), [list.data]);
  const jobs = useQuery({
    queryKey: ["jobs", workspaceId, appId],
    queryFn: () => api.get<Page<Job>>(api.ws("/jobs"), { appId, limit: 100 }),
    enabled: Boolean(followed.length),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((j) => j.status === "queued" || j.status === "running") ? 3000 : 15_000),
  });
  const finals = useQuery({ queryKey: ["renders", workspaceId, appId], queryFn: () => api.get<Page<MediaAsset>>(api.ws("/assets"), { appId, role: "render", limit: 60 }), enabled: Boolean(followed.length), refetchInterval: 10_000 });
  const details = useQueries({
    queries: followed.map((c) => ({
      queryKey: ["campaign", workspaceId, c.id],
      queryFn: () => api.get<CampaignDetailResponse>(api.ws(`/campaigns/${c.id}`)),
      refetchInterval: 5000,
    })),
  });
  const runs: CreateRun[] = [];
  const allJobs = jobs.data?.items ?? [];
  const footageBusy = allJobs.some((j) => (j.type === "media.extract_ui" || j.type === "media.analyze_recording") && (j.status === "queued" || j.status === "running"));
  followed.forEach((c, i) => {
    const d = details[i]?.data;
    if (!d) return;
    runs.push({ campaign: d.campaign, view: runView({ campaign: d.campaign, variants: d.variants, compositions: d.compositions, jobs: allJobs, finals: finals.data?.items ?? [], footageBusy, now: Date.now() }) });
  });
  return { runs, loading: list.isLoading, refetch: () => Promise.all([list.refetch(), jobs.refetch(), finals.refetch()]) };
}

export function RunCard({ run }: { run: CreateRun }) {
  const ac = useAccent();
  const [playing, setPlaying] = useState(false);
  const v = run.view;
  const title = v.ideaTitle || firstSentence(run.campaign.request, 90) || run.campaign.name;
  const done = v.step === "done";
  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <T v="caption" style={{ color: done ? color.success : v.failure ? color.warning : ac.accent, fontWeight: "700", letterSpacing: 0.3 }}>
            {done ? "READY" : v.failure ? "STOPPED" : v.stale ? "PAUSED" : "MAKING YOUR VIDEO"}
          </T>
          <T v="headline" numberOfLines={2}>
            {title || "Your video"}
          </T>
        </View>
        {v.working ? <Spinner /> : null}
      </View>
      {!done ? <ProgressBar value={v.working ? v.pct : v.pct || null} /> : null}
      <View style={{ gap: 6 }}>
        {STEPS.map((s) => {
          const st = stepState(v, s);
          return (
            <View key={s} style={styles.step}>
              <View style={[styles.stepDot, st === "done" && { backgroundColor: color.success, borderColor: color.success }, st === "current" && { borderColor: ac.accent }, st === "failed" && { borderColor: color.warning }]}>
                {st === "done" ? <Check size={11} color={color.white} strokeWidth={3} /> : null}
              </View>
              <T v="footnote" style={{ color: st === "todo" ? color.ink3 : st === "failed" ? color.warning : color.ink, fontWeight: st === "current" ? "600" : "400" }}>
                {STEP_LABEL[s]}
              </T>
            </View>
          );
        })}
      </View>
      <T v="footnote" style={{ color: v.failure ? color.warning : color.ink2 }}>
        {runLine(v)}
      </T>
      {done && v.finalAssetId ? (
        <>
          <Pressable onPress={() => setPlaying(true)} accessibilityRole="button" accessibilityLabel={`Play ${title}`} style={({ pressed }) => [styles.play, pressed && { opacity: 0.8 }]}>
            <Play size={16} color={color.white} fill={color.white} />
            <T v="bodySm" style={{ color: color.white, fontWeight: "600" }}>
              Watch it
            </T>
          </Pressable>
          <T v="caption">It’s in Your content on the web, ready to post. Nothing is posted without your OK.</T>
          <VideoModal assetId={v.finalAssetId} open={playing} onClose={() => setPlaying(false)} title={title} />
        </>
      ) : null}
    </Card>
  );
}

export function RunsSection({ runs }: { runs: CreateRun[] }) {
  if (!runs.length) return null;
  return (
    <View style={{ gap: 12 }}>
      <SectionTitle title="Your videos" />
      {runs.map((r) => (
        <RunCard key={r.campaign.id} run={r} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: color.lineStrong, alignItems: "center", justifyContent: "center" },
  play: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, alignSelf: "flex-start", backgroundColor: color.ink, borderRadius: 999, paddingHorizontal: 16, minHeight: 40 },
});
