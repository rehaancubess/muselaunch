/**
 * Home: "Your content is ready · N posts to review", the next post (video, caption, where, when;
 * Schedule post / Edit / Skip), Coming up, and what else waits on the web. Data: GET /apps/:id/today
 * and /calendar, the same as the web's Home.
 */
import { router } from "expo-router";
import { Plus } from "lucide-react-native";
import { useRef, useState, type ComponentRef } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { errorMessage, can } from "../../api/client";
import { useToday } from "../../api/hooks";
import { AppHeader } from "../../features/header";
import { ComingUp } from "../../features/home/coming-up";
import { NextPostCard } from "../../features/home/next-post";
import { headlineOf, plural } from "../../lib/home-lines";
import { useSession } from "../../session";
import { Button, Notice, Spinner, T } from "../../ui/components";
import { color, space } from "../../ui/theme";
import { useAccent } from "../../ui/accent";

export default function HomeScreen() {
  const ac = useAccent();
  const { app, member, appsLoading, meLoading, meError, apps } = useSession();
  const today = useToday();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const posts = today.data?.posts ?? [];
  const next = posts.find((p) => p.id === focusId) ?? posts[0];
  const rest = posts.filter((p) => p.id !== next?.id);
  const head = headlineOf(posts);
  const canWrite = can(member, "content.write");
  const others = today.data?.needs.length ?? 0;

  return (
    <SafeAreaView edges={["top"]} style={{ flex: 1, backgroundColor: color.canvas }}>
      <AppHeader />
      <ScrollView
        ref={scroll}
        contentContainerStyle={{ padding: space.gutter, gap: 28, paddingBottom: 40 }}
        refreshControl={<RefreshControl refreshing={today.isRefetching} onRefresh={() => void today.refetch()} tintColor={ac.accent} />}
      >
        {meLoading || appsLoading || (today.isLoading && app) ? (
          <View style={{ paddingVertical: 60, alignItems: "center" }}>
            <Spinner />
          </View>
        ) : meError ? (
          <Notice tone="warning">{`Couldn’t reach MuseLaunch: ${errorMessage(meError)}`}</Notice>
        ) : !apps.length ? (
          <View style={{ gap: 8 }}>
            <T v="title1">Add your app first</T>
            <T v="body" style={{ color: color.ink2 }}>
              Paste your App Store, Google Play or website link in MuseLaunch on the web. Its posts show up here for your OK.
            </T>
          </View>
        ) : (
          <>
            <View style={{ gap: 6 }}>
              <T v="title1" accessibilityRole="header">
                {head.title}
              </T>
              <T v="body" style={{ color: color.ink2 }} accessibilityLiveRegion="polite">
                {head.sub}
              </T>
              {head.caughtUp && canWrite ? <Button title="Create something new" icon={Plus} onPress={() => router.navigate("/create")} style={{ marginTop: 14 }} /> : null}
            </View>

            {today.error ? <Notice tone="warning">{`Couldn’t load what’s waiting: ${errorMessage(today.error)}`}</Notice> : null}

            {next ? <NextPostCard key={next.id} post={next} /> : null}

            <ComingUp
              posts={rest}
              hasNext={Boolean(next)}
              onCreate={!head.caughtUp && canWrite ? () => router.navigate("/create") : undefined}
              onOpen={(id) => {
                setFocusId(id);
                scroll.current?.scrollTo({ y: 0, animated: true });
              }}
            />

            {others ? (
              <Notice>{`${plural(others, "other decision")} ${others === 1 ? "waits" : "wait"} for you in MuseLaunch on the web (Needs you). Only what Muse never does on its own.`}</Notice>
            ) : null}

            <T v="caption" style={{ textAlign: "center" }}>
              Nothing is posted without your OK.
            </T>
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
