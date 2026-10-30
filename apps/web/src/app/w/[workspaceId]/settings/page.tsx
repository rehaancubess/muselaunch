"use client";
import { Button, Field, Input, PageHeader, Section, Select, Switch, useToast } from "@muselaunch/ui";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { countryOptions } from "@/lib/countries";
import { useInvalidate } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/workspace";

const TIMEZONES = (() => {
  try {
    const zones = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
    // Workspaces default to "UTC", which some runtimes leave out of the list (the select would show the first zone).
    return zones.includes("UTC") ? zones : ["UTC", ...zones];
  } catch {
    return ["UTC"];
  }
})();

/**
 * Growth Autopilot defaults: on = new apps start a run after import and Creator opens on it;
 * off = "I'll do it myself". Letting renders run without asking and the per-run limit pre-authorise
 * spending, so they need billing.manage (the API enforces both).
 */
function AutopilotSettings() {
  const { workspace, workspaceId, can, refetch } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const s = workspace?.settings.autopilot ?? { enabled: true, autoApproveRenders: true };
  const [limit, setLimit] = useState(s.maxCreditsPerRun ? String(s.maxCreditsPerRun) : "");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => setLimit(s.maxCreditsPerRun ? String(s.maxCreditsPerRun) : ""), [s.maxCreditsPerRun]);
  const manage = can("workspace.manage");
  const money = manage && can("billing.manage");
  const save = async (key: string, patch: Record<string, unknown>, done: string) => {
    setBusy(key);
    try {
      await api.patch(wsPath(workspaceId), { settings: { autopilot: patch } });
      refetch();
      await invalidate("/v1/me", wsPath(workspaceId));
      toast.success(done);
    } catch (err) {
      toast.error("Couldn’t save", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const limitN = limit.trim() ? Number.parseInt(limit, 10) : null;
  const limitValid = limitN === null || (Number.isInteger(limitN) && limitN > 0 && limitN <= 2000);
  return (
    <div className="divide-y divide-line rounded-xl bg-surface shadow-raised">
      <label className="flex items-start justify-between gap-4 p-5 sm:p-6" htmlFor="ap-enabled">
        <span className="min-w-0 space-y-1">
          <span className="block text-body font-medium text-ink">Let MuseLaunch run growth (recommended)</span>
          <span className="block text-footnote text-ink-2 text-pretty">
            New apps start Growth Autopilot after import: research, videos, checks and post drafts. Creator opens on what it’s doing. Turn off to do it yourself, step by step.
          </span>
        </span>
        <Switch
          id="ap-enabled"
          label="Growth Autopilot"
          checked={s.enabled}
          disabled={!manage || busy !== null}
          onCheckedChange={(v) => void save("enabled", { enabled: v }, v ? "Autopilot is on" : "Autopilot is off: you’re in control of each step")}
        />
      </label>
      <label className="flex items-start justify-between gap-4 p-5 sm:p-6" htmlFor="ap-renders">
        <span className="min-w-0 space-y-1">
          <span className="block text-body font-medium text-ink">Render final videos without asking</span>
          <span className="block text-footnote text-ink-2 text-pretty">Only inside each run’s budget. {money ? "" : "Only members who manage billing can change this."}</span>
        </span>
        <Switch
          id="ap-renders"
          label="Render final videos without asking"
          checked={s.autoApproveRenders}
          disabled={!money || busy !== null}
          onCheckedChange={(v) => void save("renders", { autoApproveRenders: v }, v ? "Renders go ahead within budget" : "Renders will ask first")}
        />
      </label>
      <form
        className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (limitValid) void save("limit", { maxCreditsPerRun: limitN }, limitN ? `Runs stay within ${limitN} credits` : "No per-run limit");
        }}
      >
        <Field label="Credit limit per run" optional hint="Runs pick fewer videos to fit; going over always needs your approval." error={limitValid ? undefined : "Between 1 and 2,000 credits"}>
          {(f) => (
            <Input
              id={f.id}
              aria-describedby={f.describedBy}
              inputMode="numeric"
              placeholder="No limit"
              value={limit}
              disabled={!money}
              onChange={(e) => setLimit(e.target.value.replace(/\D/g, ""))}
              trailing={<span className="text-footnote text-ink-3">credits</span>}
            />
          )}
        </Field>
        {money ? (
          <Button type="submit" variant="secondary" loading={busy === "limit"} disabled={!limitValid || (limitN ?? undefined) === s.maxCreditsPerRun}>
            Save limit
          </Button>
        ) : null}
      </form>
      <p className="px-5 py-4 text-footnote text-ink-3 sm:px-6">Posting, creator outreach and spending past a run’s budget always wait for a person’s approval, whatever these settings say.</p>
    </div>
  );
}

const TTS_VOICES = ["alloy", "ash", "ballad", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer", "verse", "marin", "cedar"];

/**
 * Video sound defaults (Track 3): original music and effects on by default; AI voiceover (external
 * TTS, labelled, checked with Muse Voice Transcribe) off by default. AI voice spends credits on
 * every new video with narration, so switching it needs billing.manage (the API enforces it).
 */
function SoundSettings() {
  const { workspace, workspaceId, can, refetch } = useWorkspace();
  const toast = useToast();
  const invalidate = useInvalidate();
  const raw = (workspace?.settings as { sound?: { music?: boolean; sfx?: boolean; aiVoiceover?: boolean; voice?: string } } | undefined)?.sound;
  const s = { music: raw?.music ?? true, sfx: raw?.sfx ?? true, aiVoiceover: raw?.aiVoiceover ?? false, voice: raw?.voice ?? "marin" };
  const [busy, setBusy] = useState<string | null>(null);
  const manage = can("workspace.manage");
  const money = manage && can("billing.manage");
  const save = async (key: string, patch: Record<string, unknown>, done: string) => {
    setBusy(key);
    try {
      await api.patch(wsPath(workspaceId, "/sound/settings"), patch);
      refetch();
      await invalidate("/v1/me", wsPath(workspaceId));
      toast.success(done);
    } catch (err) {
      toast.error("Couldn’t save", errorMessage(err));
    } finally {
      setBusy(null);
    }
  };
  const row = (id: string, title: string, body: string, checked: boolean, enabled: boolean, onChange: (v: boolean) => void) => (
    <label className="flex items-start justify-between gap-4 p-5 sm:p-6" htmlFor={id}>
      <span className="min-w-0 space-y-1">
        <span className="block text-body font-medium text-ink">{title}</span>
        <span className="block text-footnote text-ink-2 text-pretty">{body}</span>
      </span>
      <Switch id={id} label={title} checked={checked} disabled={!enabled || busy !== null} onCheckedChange={onChange} />
    </label>
  );
  return (
    <div className="divide-y divide-line rounded-xl bg-surface shadow-raised">
      {row("snd-music", "Original music", "Every new video gets music composed for it by MuseLaunch, in the mood its storyboard asks for. Owned by you, no cost.", s.music, manage, (v) => void save("music", { music: v }, v ? "New videos get original music" : "New videos start without music"))}
      {row("snd-sfx", "Sound effects", "Subtle whooshes on transitions, taps on app taps and a shimmer on the end card.", s.sfx, manage, (v) => void save("sfx", { sfx: v }, v ? "Sound effects on" : "Sound effects off"))}
      {row(
        "snd-voice",
        "AI voiceover",
        `When a storyboard has narration, speak it with an AI voice (OpenAI TTS, external, labelled as AI) checked against the script with Muse Voice Transcribe. Uses credits per video.${money ? "" : " Only members who manage billing can change this."}`,
        s.aiVoiceover,
        money,
        (v) => void save("voice", { aiVoiceover: v }, v ? "AI voiceover on for new videos" : "AI voiceover off"),
      )}
      <div className="flex flex-col gap-3 p-5 sm:flex-row sm:items-end sm:justify-between sm:p-6">
        <Field label="AI voice" hint="A built-in voice. Voices are never cloned from a real person.">
          {(f) => <Select id={f.id} aria-describedby={f.describedBy} value={s.voice} disabled={!manage || busy !== null} onChange={(e) => void save("voicename", { voice: e.target.value }, `AI voice: ${e.target.value}`)} options={TTS_VOICES.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))} />}
        </Field>
      </div>
    </div>
  );
}

export default function WorkspaceSettingsPage() {
  const { workspace, workspaceId, can, refetch } = useWorkspace();
  const me = useMe();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState(workspace?.name ?? "");
  const [tz, setTz] = useState(workspace?.settings.defaultTimezone ?? "UTC");
  const [displayName, setDisplayName] = useState("");
  const [country, setCountry] = useState("");
  const [busy, setBusy] = useState<"ws" | "me" | null>(null);
  const countries = useMemo(() => countryOptions(), []);

  useEffect(() => {
    if (me.data) {
      setDisplayName(me.data.user.displayName ?? "");
      setCountry(me.data.user.country ?? "");
    }
  }, [me.data]);

  return (
    <div className="space-y-12">
      <PageHeader title="Settings" className="pb-0" />
      <Section title="Growth Autopilot" description="AI does the work by default. You approve what goes out.">
        <AutopilotSettings />
      </Section>
      <Section title="Sound" description="Music, effects and voice for new videos. Change any of it per video in Studio → Sound.">
        <SoundSettings />
      </Section>
      <Section title="Workspace">
        <form
          className="space-y-5 rounded-xl bg-surface p-5 shadow-raised sm:p-6"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy("ws");
            try {
              await api.patch(wsPath(workspaceId), { name: name.trim(), settings: { defaultTimezone: tz } });
              refetch();
              await invalidate("/v1/me");
              toast.success("Workspace saved");
            } catch (err) {
              toast.error("Couldn’t save", errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Name">{(f) => <Input id={f.id} value={name} onChange={(e) => setName(e.target.value)} maxLength={120} disabled={!can("workspace.manage")} />}</Field>
            <Field label="Time zone" hint="Used for the marketing calendar.">
              {(f) => <Select id={f.id} aria-describedby={f.describedBy} value={tz} onChange={(e) => setTz(e.target.value)} options={TIMEZONES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} disabled={!can("workspace.manage")} />}
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-line pt-4">
            <p className="text-footnote text-ink-3">Customer material is processed in Meta’s Standard data mode, never contributed for training.</p>
            {can("workspace.manage") ? (
              <Button type="submit" loading={busy === "ws"} disabled={!name.trim()}>
                Save
              </Button>
            ) : null}
          </div>
        </form>
      </Section>
      <Section title="Your profile">
        <form
          className="space-y-5 rounded-xl bg-surface p-5 shadow-raised sm:p-6"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy("me");
            try {
              await api.patch("/v1/me", { displayName: displayName.trim() || undefined, country: country || undefined });
              await invalidate("/v1/me", "/v1/status/providers");
              toast.success("Profile saved");
            } catch (err) {
              toast.error("Couldn’t save", errorMessage(err));
            } finally {
              setBusy(null);
            }
          }}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Display name">{(f) => <Input id={f.id} value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={120} />}</Field>
            <Field label="Country" hint="Decides which AI providers you’re eligible for.">
              {(f) => <Select id={f.id} aria-describedby={f.describedBy} value={country} onChange={(e) => setCountry(e.target.value)} options={countries} placeholder="Choose a country" />}
            </Field>
          </div>
          <div className="flex justify-end border-t border-line pt-4">
            <Button type="submit" loading={busy === "me"}>
              Save profile
            </Button>
          </div>
        </form>
      </Section>
    </div>
  );
}
