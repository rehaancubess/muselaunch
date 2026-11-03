/**
 * Results: "See what is working", read-only. The three numbers (each with where it comes from, or
 * "Not measured yet"), the daily chart (gaps stay gaps), the best post and one tip (never as a
 * cause, with its sample). Data: GET /insights/overview and /insights/results, the latest test with
 * a result and Muse's recommendations, the same as the web.
 */
import { useQuery } from "@tanstack/react-query";
import { ChartNoAxesColumn, Eye, Layers, MousePointerClick, Sparkles } from "lucide-react-native";
import { useMemo, useState } from "react";
import { Image, Linking, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorMessage } from "../../api/client";
import { useAssetUrl } from "../../api/hooks";
import type { Experiment, ExperimentResult, GrowthRecommendation, InsightsOverview, Page, ResultsSummary } from "../../api/types";
import { AppHeader } from "../../features/header";
import { DailyChart } from "../../features/results/chart";
import { channelLabel } from "../../lib/home-lines";
import {
  RANGES,
  bestPostLine,
  chartCaption,
  chartFootnote,
  chartHiddenLine,
  coverageLine,
  fullNumber,
  latestTestWithResult,
  nothingYet,
  pickTip,
  rangeQuery,
  shortNumber,
  tiles as buildTiles,
  type RangeKey,
  type Tile,
} from "../../lib/results-lines";
import { useSession } from "../../session";
import { ChannelMark } from "../../ui/channel";
import { Card, Chip, Divider, Notice, Spinner, T } from "../../ui/components";
import { color, space } from "../../ui/theme";
import { useAccent } from "../../ui/accent";

const TILE_ICON = { views: Eye, clicks: MousePointerClick, posts: Layers } as const;

export default function ResultsScreen() {
  const ac = useAccent();
  const { api, appId, workspaceId } = useSession();
  const [range, setRange] = useState<RangeKey>("28");
  const q = useMemo(() => rangeQuery(range), [range]);
  const enabled = Boolean(appId && workspaceId);
  const overview = useQuery({ queryKey: ["overview", workspaceId, appId, range], queryFn: () => api.get<InsightsOverview>(api.ws(`/apps/${appId}/insights/overview`), { ...q, compare: "none" }), enabled, placeholderData: (p) => p });
  const results = useQuery({ queryKey: ["results", workspaceId, appId, range], queryFn: () => api.get<ResultsSummary>(api.ws(`/apps/${appId}/insights/results`), q), enabled, placeholderData: (p) => p });
  const exps = useQuery({ queryKey: ["experiments", workspaceId, appId], queryFn: () => api.get<Page<Experiment>>(api.ws(`/apps/${appId}/experiments`)), enabled, retry: false });
  const latest = latestTestWithResult(exps.data?.items ?? []);
  const exp = useQuery({ queryKey: ["experiment", workspaceId, latest?.id], queryFn: () => api.get<{ experiment: Experiment; results: ExperimentResult[] }>(api.ws(`/experiments/${latest!.id}`)), enabled: Boolean(latest), retry: false });
  const recs = useQuery({ queryKey: ["recommendations", workspaceId, appId], queryFn: () => api.get<Page<GrowthRecommendation>>(api.ws(`/apps/${appId}/recommendations`)), enabled, retry: false });

  const ov = overview.data;
  const res = results.data;
  const t = ov && res ? buildTiles(ov.metrics, ov.missing, res.postsPublished) : [];
  const empty = Boolean(ov && res && nothingYet(t));
  const result = exp.data ? (exp.data.results.find((x) => x.id === exp.data!.experiment.lastResultId) ?? exp.data.results[0]) : undefined;
  const tip = exps.isLoading || recs.isLoading || (latest && exp.isLoading) ? null : pickTip(exp.data ? { exp: exp.data.experiment, result } : null, recs.data?.items ?? []);
  const fetching = overview.isFetching || results.isFetching;

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: color.canvas }}>
      <AppHeader />
      <ScrollView contentContainerStyle={{ padding: space.gutter, gap: 24, paddingBottom: 48 }} refreshControl={<RefreshControl refreshing={false} onRefresh={() => void Promise.all([overview.refetch(), results.refetch(), recs.refetch()])} tintColor={ac.accent} />}>
        <View style={{ gap: 12 }}>
          <T v="title1" accessibilityRole="header">
            See what is working
          </T>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {RANGES.map((r) => (
              <Chip key={r.value} label={r.label} selected={r.value === range} onPress={() => setRange(r.value)} />
            ))}
          </View>
        </View>

        {(overview.isLoading || results.isLoading) && !(ov && res) ? (
          <View style={{ paddingVertical: 48, alignItems: "center" }}>
            <Spinner />
          </View>
        ) : (overview.error && !ov) || (results.error && !res) ? (
          <Notice tone="warning">{`Couldn’t load your results: ${errorMessage(overview.error ?? results.error)}`}</Notice>
        ) : ov && res ? (
          empty ? (
            <Card style={{ gap: 10, alignItems: "flex-start" }}>
              <ChartNoAxesColumn size={24} color={ac.accent} />
              <T v="headline">Nothing measured yet</T>
              <T v="bodySm" style={{ color: color.ink2 }}>
                {ov.missing.some((m) => m.metric === "views" && m.action === "publish_post")
                  ? "Post your first video. Views and link clicks show up here once there are real numbers, each with where it comes from."
                  : "Connect YouTube or add your numbers in MuseLaunch on the web. Nothing here is estimated."}
              </T>
            </Card>
          ) : (
            <View style={{ gap: 24, opacity: fetching ? 0.7 : 1 }}>
              <Card padded={false}>
                {t.map((tile, i) => (
                  <View key={tile.key}>
                    {i ? <Divider style={{ marginLeft: 60 }} /> : null}
                    <NumberRow tile={tile} />
                  </View>
                ))}
              </Card>
              {coverageLine(ov.metrics) ? <T v="footnote" style={{ marginTop: -12 }}>{coverageLine(ov.metrics)}</T> : null}

              {res.series ? <ChartSection summary={res} rangeDays={Number(range)} /> : null}

              {res.bestPost ? <BestPost best={res.bestPost} /> : null}
            </View>
          )
        ) : null}

        {tip ? (
          <Card style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
              <Sparkles size={20} color={ac.accent} style={{ marginTop: 2 }} />
              <T v="headline" style={{ flex: 1 }}>
                {tip.title}
              </T>
            </View>
            <T v="bodySm" style={{ color: color.ink2 }}>
              {tip.body}
            </T>
            <T v="caption">{tip.basis}</T>
            {tip.caution ? <T v="caption" style={{ color: color.warning }}>{tip.caution}</T> : null}
            <T v="caption">What went together, not proof of why. Make the next video on Create.</T>
          </Card>
        ) : null}

        <T v="caption" style={{ textAlign: "center" }}>
          Every number says where it comes from. Nothing here is estimated. Your tests and every source are under Results → Details on the web.
        </T>
      </ScrollView>
    </SafeAreaView>
  );
}

function NumberRow({ tile }: { tile: Tile }) {
  const ac = useAccent();
  const Icon = TILE_ICON[tile.key];
  const measured = tile.value !== null;
  return (
    <View style={styles.row} accessible accessibilityLabel={`${tile.label}: ${measured ? fullNumber(tile.value!) : "not measured yet"}. ${tile.source ?? tile.missing ?? ""}`}>
      <View style={styles.icon}>
        <Icon size={20} color={ac.accent} strokeWidth={1.9} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T v="footnote" style={{ color: color.ink2, fontWeight: "600" }}>
          {tile.label}
        </T>
        <T v="caption" numberOfLines={2}>
          {measured ? [tile.source, tile.scope].filter(Boolean).join(" · ") : (tile.missing ?? "Not measured yet")}
        </T>
      </View>
      <T v="title2" style={{ color: measured ? color.ink : color.ink3, fontVariant: ["tabular-nums"] }}>
        {measured ? shortNumber(tile.value!) : "—"}
      </T>
    </View>
  );
}

function ChartSection({ summary, rangeDays }: { summary: ResultsSummary; rangeDays: number }) {
  const s = summary.series!;
  const hidden = chartHiddenLine(s, rangeDays);
  if (hidden) return <Notice icon={ChartNoAxesColumn}>{hidden}</Notice>;
  const foot = chartFootnote(s);
  return (
    <View style={{ gap: 8 }}>
      <T v="footnote" style={{ fontWeight: "600" }}>
        {chartCaption(s)}
      </T>
      <Card style={{ paddingHorizontal: 8, paddingVertical: 12 }}>
        <DailyChart series={s} />
      </Card>
      {foot ? <T v="caption">{foot}</T> : null}
    </View>
  );
}

function BestPost({ best }: { best: NonNullable<ResultsSummary["bestPost"]> }) {
  const ac = useAccent();
  const thumb = useAssetUrl(best.thumbnailAssetId);
  const what = best.metric === "views" ? "Views" : "Link clicks";
  const open = best.remoteUrl ? () => void Linking.openURL(best.remoteUrl!) : undefined;
  return (
    <View style={{ gap: 10 }}>
      <T v="title3">Best-performing post</T>
      <Pressable disabled={!open} onPress={open} accessibilityRole={open ? "link" : "text"} accessibilityLabel={`${best.title}, ${channelLabel(best.channel)}: ${fullNumber(best.value)} ${what.toLowerCase()}`}>
        {({ pressed }) => (
          <Card style={[styles.best, pressed && { opacity: 0.8 }]}>
            <View style={[styles.bestThumb, { backgroundColor: ac.accentSoft }]}>{thumb.data?.url ? <Image source={{ uri: thumb.data.url }} style={StyleSheet.absoluteFill} resizeMode="cover" /> : <Layers size={20} color={ac.accent} />}</View>
            <View style={{ flex: 1, gap: 4 }}>
              <T v="bodySm" style={{ fontWeight: "600" }} numberOfLines={2}>
                {best.title}
              </T>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <ChannelMark channel={best.channel} size={14} />
                <T v="caption" style={{ color: color.ink2 }}>
                  {channelLabel(best.channel)}
                </T>
              </View>
            </View>
            <View style={{ alignItems: "flex-end" }}>
              <T v="title3">{shortNumber(best.value)}</T>
              <T v="caption">{what}</T>
            </View>
          </Card>
        )}
      </Pressable>
      <T v="caption">{bestPostLine(best)}</T>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 14, paddingHorizontal: 16, paddingVertical: 14 },
  icon: { width: 30, alignItems: "center" },
  best: { flexDirection: "row", alignItems: "center", gap: 14, padding: 12 },
  bestThumb: { width: 60, height: 60, borderRadius: 12, overflow: "hidden", alignItems: "center", justifyContent: "center" },
});
