"use client";
import type { BrandProfile } from "@muselaunch/contracts";
import { Button, Field, IconButton, Input, Select, TagInput, Textarea, useToast } from "@muselaunch/ui";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useInvalidate } from "@/lib/query";

type Palette = BrandProfile["visual"]["palette"];
const ROLES = ["primary", "secondary", "accent", "background", "text", "other"] as const;
const HEX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;

function GroupCard({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-4 border-t border-line py-6 first:border-t-0 first:pt-0 md:grid-cols-[minmax(0,2fr)_minmax(0,5fr)] md:gap-8">
      <div className="space-y-1">
        <p className="text-body-sm font-semibold">{title}</p>
        {description ? <p className="text-footnote text-ink-2 text-pretty">{description}</p> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

/** Tone, palette, fonts, CTAs and guardrails → `PATCH /apps/:appId/dna`. */
export function BrandKitEditor({ profile, workspaceId, appId, canEdit }: { profile: BrandProfile; workspaceId: string; appId: string; canEdit: boolean }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const initial = useMemo(
    () => ({
      voice: profile.tone.voice,
      use: profile.tone.vocabularyUse,
      avoid: profile.tone.vocabularyAvoid,
      palette: profile.visual.palette,
      headingFont: profile.visual.headingFont ?? "",
      bodyFont: profile.visual.bodyFont ?? "",
      keywords: profile.visual.styleKeywords,
      ctas: profile.preferredCtas,
      prohibited: profile.prohibitedClaims,
      guidelines: profile.guidelines,
    }),
    [profile],
  );
  const [s, setS] = useState(initial);
  const [saving, setSaving] = useState(false);
  useEffect(() => setS(initial), [initial]);
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);
  const paletteValid = s.palette.every((p) => HEX.test(p.hex));

  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS((prev) => ({ ...prev, [k]: v }));
  const setSwatch = (i: number, patch: Partial<Palette[number]>) => set("palette", s.palette.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(wsPath(workspaceId, `/apps/${appId}/dna`), {
        tone: { voice: s.voice, vocabularyUse: s.use, vocabularyAvoid: s.avoid },
        visual: { ...profile.visual, palette: s.palette, headingFont: s.headingFont || undefined, bodyFont: s.bodyFont || undefined, styleKeywords: s.keywords },
        preferredCtas: s.ctas,
        prohibitedClaims: s.prohibited,
        guidelines: s.guidelines,
      });
      await invalidate(wsPath(workspaceId, `/apps/${appId}/dna`));
      toast.success("Brand kit saved", "Future campaigns use these settings. Re-analysis won’t overwrite your edits.");
    } catch (e) {
      toast.error("Couldn’t save the brand kit", errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl bg-surface p-5 shadow-raised sm:p-6">
      <GroupCard title="Voice" description="How your brand sounds. Muse writes scripts and captions in this voice.">
        <Field label="Tone">{(f) => <TagInput id={f.id} label="Tone words" value={s.voice} onChange={(v) => set("voice", v)} placeholder="e.g. calm, precise, warm" disabled={!canEdit} max={12} />}</Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Words to use">{(f) => <TagInput id={f.id} label="Words to use" value={s.use} onChange={(v) => set("use", v)} disabled={!canEdit} />}</Field>
          <Field label="Words to avoid">{(f) => <TagInput id={f.id} label="Words to avoid" value={s.avoid} onChange={(v) => set("avoid", v)} disabled={!canEdit} tone="danger" />}</Field>
        </div>
      </GroupCard>

      <GroupCard title="Palette" description="Taken from your icon and screenshots. Adjust to match your brand.">
        <ul className="space-y-2">
          {s.palette.map((p, i) => (
            <li key={i} className="flex items-center gap-2">
              <label className="relative size-9 shrink-0 cursor-pointer overflow-hidden rounded-md shadow-[inset_0_0_0_1px_rgb(0_0_0/0.1)]" style={{ background: HEX.test(p.hex) ? p.hex : "#fff" }}>
                <span className="sr-only">Pick colour {i + 1}</span>
                <input type="color" disabled={!canEdit} value={HEX.test(p.hex) && p.hex.length === 7 ? p.hex : "#000000"} onChange={(e) => setSwatch(i, { hex: e.target.value })} className="absolute inset-0 size-full cursor-pointer opacity-0" />
              </label>
              <Input aria-label={`Hex colour ${i + 1}`} value={p.hex} onChange={(e) => setSwatch(i, { hex: e.target.value })} invalid={!HEX.test(p.hex)} disabled={!canEdit} className="w-28 tabular uppercase" maxLength={7} />
              <div className="w-36">
                <Select aria-label={`Role of colour ${i + 1}`} value={p.role} onChange={(e) => setSwatch(i, { role: e.target.value as Palette[number]["role"] })} options={ROLES.map((r) => ({ value: r, label: r[0]!.toUpperCase() + r.slice(1) }))} disabled={!canEdit} />
              </div>
              {canEdit ? (
                <IconButton label={`Remove colour ${i + 1}`} size="sm" onClick={() => set("palette", s.palette.filter((_, j) => j !== i))}>
                  <Trash2 className="size-3.5" aria-hidden />
                </IconButton>
              ) : null}
            </li>
          ))}
        </ul>
        {canEdit && s.palette.length < 12 ? (
          <Button size="sm" variant="ghost" icon={<Plus className="size-3.5" aria-hidden />} onClick={() => set("palette", [...s.palette, { hex: "#3355FF", role: "accent" }])}>
            Add colour
          </Button>
        ) : null}
      </GroupCard>

      <GroupCard title="Type & style" description="Fonts are matched to licensed equivalents when rendering.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Heading font">{(f) => <Input id={f.id} value={s.headingFont} onChange={(e) => set("headingFont", e.target.value)} placeholder="e.g. SF Pro Display" disabled={!canEdit} />}</Field>
          <Field label="Body font">{(f) => <Input id={f.id} value={s.bodyFont} onChange={(e) => set("bodyFont", e.target.value)} placeholder="e.g. Inter" disabled={!canEdit} />}</Field>
        </div>
        <Field label="Style keywords">{(f) => <TagInput id={f.id} label="Style keywords" value={s.keywords} onChange={(v) => set("keywords", v)} placeholder="e.g. minimal, airy, high contrast" disabled={!canEdit} max={20} />}</Field>
      </GroupCard>

      <GroupCard title="Calls to action & guardrails" description="Muse never uses prohibited claims, even if a concept would benefit from them.">
        <Field label="Preferred calls to action">{(f) => <TagInput id={f.id} label="Preferred calls to action" value={s.ctas} onChange={(v) => set("ctas", v)} placeholder="e.g. Try it free on iPhone" disabled={!canEdit} max={20} />}</Field>
        <Field label="Never claim">{(f) => <TagInput id={f.id} label="Prohibited claims" value={s.prohibited} onChange={(v) => set("prohibited", v)} placeholder="e.g. #1 productivity app" disabled={!canEdit} tone="danger" maxLength={300} />}</Field>
        <Field label="Guidelines" optional>
          {(f) => <Textarea id={f.id} rows={4} value={s.guidelines} onChange={(e) => set("guidelines", e.target.value)} placeholder="Anything else a designer should know: logo usage, imagery to avoid, legal lines…" disabled={!canEdit} maxLength={4000} />}
        </Field>
      </GroupCard>

      {canEdit ? (
        <div className="flex items-center justify-end gap-2 border-t border-line pt-5">
          {dirty ? (
            <Button variant="ghost" onClick={() => setS(initial)}>
              Discard
            </Button>
          ) : null}
          <Button onClick={save} loading={saving} disabled={!dirty || !paletteValid}>
            Save brand kit
          </Button>
        </div>
      ) : null}
    </div>
  );
}
