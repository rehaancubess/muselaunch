"use client";
import { Button, Field, Input, PageHeader, Section, Select, useToast } from "@muselaunch/ui";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { countryOptions } from "@/lib/countries";
import { useInvalidate } from "@/lib/query";
import { useMe, useWorkspace } from "@/lib/workspace";

const TIMEZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? ["UTC"];
  } catch {
    return ["UTC"];
  }
})();

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
