"use client";
import type { BrandPreference, Competitor } from "@muselaunch/contracts";
import { Avatar, Badge, Button, Dialog, EmptyState, Field, IconButton, Input, Select, Skeleton, SourceChip, Switch, Textarea, Tooltip, useToast } from "@muselaunch/ui";
import { Brain, Plus, Swords, Trash2 } from "lucide-react";
import { useState } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import type { Page } from "@/lib/api-types";
import { relativeTime } from "@/lib/labels";
import { useApiQuery, useInvalidate } from "@/lib/query";

function ListSkeleton() {
  return (
    <div className="space-y-2">
      {[0, 1].map((i) => (
        <Skeleton key={i} className="h-16" rounded="xl" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- Competitors

export function CompetitorsSection({ workspaceId, appId, canEdit }: { workspaceId: string; appId: string; canEdit: boolean }) {
  const path = wsPath(workspaceId, `/apps/${appId}/competitors`);
  const q = useApiQuery<Page<Competitor>>(path);
  const toast = useToast();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [saving, setSaving] = useState(false);

  const add = async () => {
    setSaving(true);
    try {
      const u = url.trim() ? (/^https?:\/\//.test(url.trim()) ? url.trim() : `https://${url.trim()}`) : undefined;
      const body: Record<string, unknown> = { name: name.trim() };
      if (u && /apps\.apple\.com/.test(u)) body.storeUrls = { ios: u };
      else if (u && /play\.google\.com/.test(u)) body.storeUrls = { android: u };
      else if (u) body.websiteUrl = u;
      await api.post(path, body);
      await invalidate(path);
      setOpen(false);
      setName("");
      setUrl("");
    } catch (e) {
      toast.error("Couldn’t add the competitor", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <QueryState query={q} feature="Competitors" skeleton={<ListSkeleton />}>
        {(data) =>
          data.items.length ? (
            <ul className="grid gap-3 md:grid-cols-2">
              {data.items.map((c) => (
                <li key={c.id} className="space-y-3 rounded-xl bg-surface p-4 shadow-raised">
                  <div className="flex items-start gap-3">
                    <Avatar name={c.name} size={36} shape="squircle" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-body-sm font-semibold">{c.name}</p>
                      <p className="text-caption text-ink-2">{c.origin === "research" ? `Found by research${c.lastResearchedAt ? `, ${relativeTime(c.lastResearchedAt)}` : ""}` : "Added by you"}</p>
                    </div>
                    {canEdit ? (
                      <IconButton
                        label={`Remove ${c.name}`}
                        size="sm"
                        onClick={async () => {
                          try {
                            await api.del(`${path}/${c.id}`);
                            await invalidate(path);
                          } catch (e) {
                            toast.error("Couldn’t remove", errorMessage(e));
                          }
                        }}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </IconButton>
                    ) : null}
                  </div>
                  {c.positioning ? <p className="text-footnote text-ink-2 text-pretty">{c.positioning}</p> : <p className="text-footnote text-ink-3">Positioning appears after research runs.</p>}
                  {c.observedHooks.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {c.observedHooks.slice(0, 3).map((h) => (
                        <Badge key={h} tone="neutral">
                          “{h}”
                        </Badge>
                      ))}
                    </div>
                  ) : null}
                  {c.sources.length ? (
                    <div className="flex flex-wrap gap-1.5">
                      {c.sources.slice(0, 3).map((s, i) => (
                        <SourceChip key={i} source={s} compact />
                      ))}
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl bg-mist/60">
              <EmptyState size="sm" icon={<Swords aria-hidden />} title="No competitors yet" description="Add the apps you’re compared with. Research fills in their positioning and the hooks they use, with sources." />
            </div>
          )
        }
      </QueryState>
      {canEdit ? (
        <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setOpen(true)}>
          Add competitor
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add a competitor"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={add} loading={saving} disabled={!name.trim()}>
              Add competitor
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">{(f) => <Input id={f.id} value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} />}</Field>
          <Field label="Store link or website" optional>
            {(f) => <Input id={f.id} value={url} onChange={(e) => setUrl(e.target.value)} inputMode="url" placeholder="apps.apple.com/app/…" />}
          </Field>
        </div>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------- Memory (Glimmer)

const KIND_LABEL: Record<BrandPreference["kind"], string> = {
  style: "Style",
  tone: "Tone",
  angle_accepted: "Liked angle",
  angle_rejected: "Rejected angle",
  edit_instruction: "Edit habit",
  decision: "Decision",
  lesson: "Lesson",
  constraint: "Constraint",
};

const SOURCE_LABEL: Record<BrandPreference["source"]["type"], string> = {
  user_edit: "From your edits",
  approval: "From an approval",
  rejection: "From a rejection",
  experiment: "From an experiment",
  explicit: "Added by you",
  agent: "Noted by Muse",
};

export function MemorySection({ workspaceId, appId, canEdit }: { workspaceId: string; appId: string; canEdit: boolean }) {
  const path = wsPath(workspaceId, `/apps/${appId}/memory`);
  const q = useApiQuery<Page<BrandPreference>>(path);
  const toast = useToast();
  const invalidate = useInvalidate();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<BrandPreference["kind"]>("style");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);

  const update = async (id: string, body: Record<string, unknown>) => {
    try {
      await api.patch(`${path}/${id}`, body);
      await invalidate(path);
    } catch (e) {
      toast.error("Couldn’t update memory", errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      <QueryState query={q} feature="Brand memory" skeleton={<ListSkeleton />}>
        {(data) =>
          data.items.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-xl bg-surface shadow-raised">
              {data.items.map((m) => (
                <li key={m.id} className="flex items-start gap-3 px-4 py-3.5">
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className={m.active ? "text-body-sm text-ink" : "text-body-sm text-ink-3"}>{m.text}</p>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge tone="neutral">{KIND_LABEL[m.kind]}</Badge>
                      <span className="text-caption text-ink-3">
                        {SOURCE_LABEL[m.source.type]}, {relativeTime(m.createdAt)}
                      </span>
                      {!m.appId ? <Badge tone="outline">Whole workspace</Badge> : null}
                    </div>
                  </div>
                  {canEdit ? (
                    <div className="flex shrink-0 items-center gap-1">
                      <Tooltip content={m.active ? "Used in future campaigns" : "Ignored"}>
                        <span>
                          <Switch checked={m.active} onCheckedChange={(v) => update(m.id, { active: v })} label={`Use “${m.text.slice(0, 40)}” in future campaigns`} />
                        </span>
                      </Tooltip>
                      <IconButton
                        label="Forget this"
                        size="sm"
                        onClick={async () => {
                          try {
                            await api.del(`${path}/${m.id}`);
                            await invalidate(path);
                          } catch (e) {
                            toast.error("Couldn’t delete", errorMessage(e));
                          }
                        }}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </IconButton>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="rounded-xl bg-mist/60">
              <EmptyState size="sm" icon={<Brain aria-hidden />} title="Nothing remembered yet" description="As you approve, reject and edit, Muse Glimmer remembers your preferences here, and you can turn any of them off." />
            </div>
          )
        }
      </QueryState>
      {canEdit ? (
        <Button size="sm" variant="secondary" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => setOpen(true)}>
          Add a preference
        </Button>
      ) : null}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Add a preference"
        description="Tell Muse something to always keep in mind, like “Never show prices in videos”."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              loading={saving}
              disabled={text.trim().length < 3}
              onClick={async () => {
                setSaving(true);
                try {
                  await api.post(path, { kind, text: text.trim() });
                  await invalidate(path);
                  setOpen(false);
                  setText("");
                } catch (e) {
                  toast.error("Couldn’t save", errorMessage(e));
                } finally {
                  setSaving(false);
                }
              }}
            >
              Remember this
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Type">
            {(f) => (
              <Select
                id={f.id}
                value={kind}
                onChange={(e) => setKind(e.target.value as BrandPreference["kind"])}
                options={(["style", "tone", "constraint", "decision", "lesson"] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }))}
              />
            )}
          </Field>
          <Field label="Preference">{(f) => <Textarea id={f.id} rows={3} value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} autoFocus />}</Field>
        </div>
      </Dialog>
    </div>
  );
}
