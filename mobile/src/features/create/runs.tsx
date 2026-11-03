/**
 * Create runs on the phone: the videos "Generate video" started. The server carries each run to the
 * finished video (GET /apps/:appId/create-runs is its read model); the phone shows where it stands
 * and answers the decisions it stops at (POST /create-runs/:id/resolve: try again, finish at the new
 * price). On an API that predates server runs, it falls back to reading the stored records itself
 * (lib/plan.ts runView). The phone never takes a run's steps.
 */
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Play } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { ApiError, can, errorMessage } from "../../api/client";
import type { Campaign, CampaignDetailResponse, CreateRunView, Job, MediaAsset, Page } from "../../api/types";
import { displayFromRecords, displayFromServer, runView, STEP_LABEL, STEPS, stepStateOf, type RunDisplay } from "../../lib/plan";
import { useSession } from "../../session";
import { useAccent } from "../../ui/accent";
import { Button, Card, ProgressBar, SectionTitle, Spinner, T } from "../../ui/components";
import { color } from "../../ui/theme";
import { useToast } from "../../ui/toast";
import { VideoModal } from "../home/post-video";

const FOLLOW_MS = 7 * 86_400_000;
const MAX_FOLLOWED = 4;

const routeMissing = (e: unknown) => e instanceof ApiError && e.status === 404 && /^Route /.test(e.message);

export function useCreateRuns(): { runs: RunDisplay[]; loading: boolean; refetch: () => Promise<unknown> } {
  const { api, appId, workspaceId } = useSession();
  const enabled = Boolean(appId && workspaceId);
  const server = useQuery({
    queryKey: ["create-runs", workspaceId, appId],
    queryFn: () => api.get<{ items: CreateRunView[] }>(api.ws(`/apps/${appId}/create-runs`), { limit: MAX_FOLLOWED }),
    enabled,
    retry: false,
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((r) => r.status === "working" || r.status === "waiting") ? 3000 : 15_000),
  });
  // An API without server runs yet: read the stored records like the web used to.
  const fallback = enabled && routeMissing(server.error);
  const list = useQuery({ queryKey: ["campaigns", workspaceId, appId], queryFn: () => api.get<Page<Campaign>>(api.ws(`/apps/${appId}/campaigns`)), enabled: fallback, staleTime: 10_000 });
  const followed = useMemo(() => (list.data?.items ?? []).filter((c) => c.origin === "create" && c.status !== "archived" && Date.now() - Date.parse(c.createdAt) < FOLLOW_MS).slice(0, MAX_FOLLOWED), [list.data]);
  const jobs = useQuery({
    queryKey: ["jobs", workspaceId, appId],
    queryFn: () => api.get<Page<Job>>(api.ws("/jobs"), { appId, limit: 100 }),
    enabled: fallback && Boolean(followed.length),
    refetchInterval: (q) => ((q.state.data?.items ?? []).some((j) => j.status === "queued" || j.status === "running") ? 3000 : 15_000),
  });
  const finals = useQuery({ queryKey: ["renders", workspaceId, appId], queryFn: () => api.get<Page<MediaAsset>>(api.ws("/assets"), { appId, role: "render", limit: 60 }), enabled: fallback && Boolean(followed.length), refetchInterval: 10_000 });
  const details = useQueries({
    queries: followed.map((c) => ({ queryKey: ["campaign", workspaceId, c.id], queryFn: () => api.get<CampaignDetailResponse>(api.ws(`/campaigns/${c.id}`)), refetchInterval: 5000, enabled: fallback })),
  });

  if (!fallback) return { runs: (server.data?.items ?? []).map(displayFromServer), loading: server.isLoading, refetch: () => server.refetch() };
  const allJobs = jobs.data?.items ?? [];
  const footageBusy = allJobs.some((j) => (j.type === "media.extract_ui" || j.type === "media.analyze_recording") && (j.status === "queued" || j.status === "running"));
  const runs: RunDisplay[] = [];
  followed.forEach((c, i) => {
    const d = details[i]?.data;
    if (d) runs.push(displayFromRecords(d.campaign, runView({ campaign: d.campaign, variants: d.variants, compositions: d.compositions, jobs: allJobs, finals: finals.data?.items ?? [], footageBusy, now: Date.now() })));
  });
  return { runs, loading: list.isLoading, refetch: () => Promise.all([list.refetch(), jobs.refetch(), finals.refetch()]) };
}

const LABEL: Record<RunDisplay["status"], string> = { working: "MAKING YOUR VIDEO", waiting: "MAKING YOUR VIDEO", needs_you: "NEEDS YOU", failed: "STOPPED", stopped: "PAUSED", done: "READY" };

export function RunCard({ run }: { run: RunDisplay }) {
  const ac = useAccent();
  const { api, member } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const done = run.status === "done";
  const tone = done ? color.success : run.status === "needs_you" || run.status === "failed" ? color.warning : ac.accent;

  const resolve = async () => {
    if (!run.action) return;
    setBusy(true);
    try {
      await api.post(api.ws(`/create-runs/${run.campaignId}/resolve`), { action: run.action.kind, ...(run.action.stepKey ? { stepKey: run.action.stepKey } : {}) });
      toast({ title: run.action.kind === "approve_spend" ? "Finishing your video" : "Carrying on", body: "MuseLaunch takes it from here." });
      await qc.invalidateQueries({ queryKey: ["create-runs"] });
    } catch (e) {
      toast({ title: "Couldn’t do that", body: errorMessage(e), tone: "error" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <T v="caption" style={{ color: tone, fontWeight: "700", letterSpacing: 0.3 }}>
            {LABEL[run.status]}
          </T>
          <T v="headline" numberOfLines={2}>
            {run.title}
          </T>
        </View>
        {run.status === "working" ? <Spinner /> : null}
      </View>
      {!done ? <ProgressBar value={run.status === "working" || run.pct ? run.pct : null} /> : null}
      <View style={{ gap: 6 }}>
        {STEPS.map((s) => {
          const st = stepStateOf(run, s);
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
      <T v="footnote" style={{ color: run.status === "needs_you" || run.status === "failed" ? color.warning : color.ink2 }}>
        {run.line}
      </T>
      {run.action && can(member, "content.write") ? <Button title={run.action.label} size="md" variant={run.action.kind === "approve_spend" ? "primary" : "outline"} loading={busy} onPress={() => void resolve()} /> : null}
      {run.status === "needs_you" && !run.action ? <T v="caption">Decide this one in MuseLaunch on the web (Create).</T> : null}
      {done && run.videoAssetId ? (
        <>
          <Pressable onPress={() => setPlaying(true)} accessibilityRole="button" accessibilityLabel={`Play ${run.title}`} style={({ pressed }) => [styles.play, pressed && { opacity: 0.8 }]}>
            <Play size={16} color={color.white} fill={color.white} />
            <T v="bodySm" style={{ color: color.white, fontWeight: "600" }}>
              Watch it
            </T>
          </Pressable>
          <T v="caption">It’s in Your content on the web, ready to post. Nothing is posted without your OK.</T>
          <VideoModal assetId={run.videoAssetId} open={playing} onClose={() => setPlaying(false)} title={run.title} />
        </>
      ) : null}
    </Card>
  );
}

export function RunsSection({ runs }: { runs: RunDisplay[] }) {
  if (!runs.length) return null;
  return (
    <View style={{ gap: 12 }}>
      <SectionTitle title="Your videos" />
      {runs.map((r) => (
        <RunCard key={r.campaignId} run={r} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  step: { flexDirection: "row", alignItems: "center", gap: 10 },
  stepDot: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: color.lineStrong, alignItems: "center", justifyContent: "center" },
  play: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, alignSelf: "flex-start", backgroundColor: color.ink, borderRadius: 999, paddingHorizontal: 16, minHeight: 40 },
});
