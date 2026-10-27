"use client";
import type { MediaRole } from "@muselaunch/contracts";
import { Button, Checkbox, IconButton, ProgressBar, Select, cn, useToast } from "@muselaunch/ui";
import { CheckCircle2, FileAudio, FileImage, FileVideo, RotateCcw, Upload, X } from "lucide-react";
import { useCallback, useRef, useState, type DragEvent } from "react";
import { api, errorMessage, uploadToSignedUrl, wsPath } from "@/lib/api";
import type { CompleteUploadResponse, UploadResponse } from "@/lib/api-types";
import { ROLE_LABEL, formatBytes } from "@/lib/labels";
import { useInvalidate } from "@/lib/query";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,image/heic,video/mp4,video/quicktime,video/webm,audio/mpeg,audio/mp4,audio/x-m4a,audio/wav,audio/webm,audio/aac";
const UPLOAD_ROLES: MediaRole[] = ["screenshot", "app_recording", "founder_clip", "logo", "icon", "product_photo", "voiceover", "music", "other"];
const NEEDS_CONSENT = new Set<MediaRole>(["founder_clip", "voiceover"]);

type ItemState = "ready" | "uploading" | "finishing" | "done" | "error";
interface Item {
  key: string;
  file: File;
  role: MediaRole;
  consent: boolean;
  state: ItemState;
  pct: number;
  error?: string;
  abort?: AbortController;
}

function guessRole(f: File): MediaRole {
  if (f.type.startsWith("video/")) return /founder|me|selfie|intro|talk/i.test(f.name) ? "founder_clip" : "app_recording";
  if (f.type.startsWith("audio/")) return "voiceover";
  if (/logo/i.test(f.name)) return "logo";
  if (/icon/i.test(f.name)) return "icon";
  return "screenshot";
}

function FileGlyph({ type }: { type: string }) {
  const cls = "size-4";
  if (type.startsWith("video/")) return <FileVideo className={cls} aria-hidden />;
  if (type.startsWith("audio/")) return <FileAudio className={cls} aria-hidden />;
  return <FileImage className={cls} aria-hidden />;
}

/**
 * Direct-to-storage uploads: `POST /uploads` → PUT to the signed URL (with progress) →
 * `POST /assets/:id/complete`. Founder recordings and voice require explicit consent.
 */
export function Uploader({ workspaceId, appId, onUploaded }: { workspaceId: string; appId: string; onUploaded?: () => void }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);

  const patch = (key: string, p: Partial<Item>) => setItems((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));

  const add = useCallback((files: FileList | File[]) => {
    const next = Array.from(files)
      .slice(0, 20)
      .map((file) => ({ key: `${file.name}-${file.size}-${Math.random().toString(36).slice(2, 7)}`, file, role: guessRole(file), consent: false, state: "ready" as const, pct: 0 }));
    setItems((xs) => [...xs, ...next]);
  }, []);

  const start = async (it: Item) => {
    if (NEEDS_CONSENT.has(it.role) && !it.consent) {
      patch(it.key, { error: "Confirm consent for recordings of a person first." });
      return;
    }
    const abort = new AbortController();
    patch(it.key, { state: "uploading", pct: 0, error: undefined, abort });
    try {
      const created = await api.post<UploadResponse>(wsPath(workspaceId, "/uploads"), {
        filename: it.file.name,
        mimeType: it.file.type || "application/octet-stream",
        bytes: it.file.size,
        role: it.role,
        appId,
        consent: NEEDS_CONSENT.has(it.role) ? { scope: "Use of my likeness and voice in marketing content for this app" } : undefined,
      });
      await uploadToSignedUrl(created.upload, it.file, (pct) => patch(it.key, { pct }), abort.signal);
      patch(it.key, { state: "finishing", pct: 100 });
      await api.post<CompleteUploadResponse>(wsPath(workspaceId, `/assets/${created.asset.id}/complete`));
      patch(it.key, { state: "done" });
      await invalidate(wsPath(workspaceId, "/assets"));
      onUploaded?.();
      setTimeout(() => setItems((xs) => xs.filter((x) => x.key !== it.key)), 2500);
    } catch (e) {
      if ((e as Error)?.name === "AbortError") return setItems((xs) => xs.filter((x) => x.key !== it.key));
      patch(it.key, { state: "error", error: errorMessage(e) });
    }
  };

  const ready = items.filter((i) => i.state === "ready");

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) add(e.dataTransfer.files);
  };

  return (
    <div className="space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn(
          "flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 py-9 text-center transition-colors",
          dragging ? "border-accent bg-accent-soft" : "border-line-strong bg-mist/50",
        )}
      >
        <span className="flex size-11 items-center justify-center rounded-full bg-surface text-ink-2 shadow-raised">
          <Upload className="size-5" aria-hidden />
        </span>
        <div className="space-y-1">
          <p className="text-body-sm font-medium">Drop screenshots, screen recordings or founder clips</p>
          <p className="text-footnote text-ink-2">PNG, JPEG, HEIC, MP4, MOV, WebM and audio. Real product media is used as proof in App DNA and in videos.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => inputRef.current?.click()}>
          Choose files
        </Button>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            if (e.target.files) add(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {items.length ? (
        <div className="overflow-hidden rounded-xl bg-surface shadow-raised">
          <ul className="divide-y divide-line">
            {items.map((it) => (
              <li key={it.key} className="space-y-2.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <span className="flex size-8 items-center justify-center rounded-md bg-mist text-ink-2">
                    <FileGlyph type={it.file.type} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-body-sm font-medium">{it.file.name}</p>
                    <p className="text-caption text-ink-2">
                      {formatBytes(it.file.size)}
                      {it.state === "uploading" ? `, ${it.pct}% uploaded` : it.state === "finishing" ? ", processing" : it.state === "done" ? ", added to Library" : ""}
                    </p>
                  </div>
                  {it.state === "ready" ? (
                    <div className="w-44">
                      <Select aria-label={`Type of ${it.file.name}`} selectSize="sm" value={it.role} onChange={(e) => patch(it.key, { role: e.target.value as MediaRole, error: undefined })} options={UPLOAD_ROLES.map((r) => ({ value: r, label: ROLE_LABEL[r] }))} />
                    </div>
                  ) : null}
                  {it.state === "done" ? <CheckCircle2 className="size-5 text-success" aria-label="Uploaded" /> : null}
                  {it.state === "error" ? (
                    <Button size="sm" variant="secondary" icon={<RotateCcw className="size-3.5" aria-hidden />} onClick={() => start(it)}>
                      Retry
                    </Button>
                  ) : null}
                  {it.state === "uploading" ? (
                    <IconButton label="Cancel upload" size="sm" onClick={() => it.abort?.abort()}>
                      <X className="size-3.5" aria-hidden />
                    </IconButton>
                  ) : it.state === "ready" || it.state === "error" ? (
                    <IconButton label="Remove" size="sm" onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}>
                      <X className="size-3.5" aria-hidden />
                    </IconButton>
                  ) : null}
                </div>
                {it.state === "ready" && NEEDS_CONSENT.has(it.role) ? (
                  <Checkbox
                    checked={it.consent}
                    onCheckedChange={(v) => patch(it.key, { consent: v, error: undefined })}
                    label="I’m the person in this recording, or I have their permission to use their likeness and voice in marketing for this app."
                    className="pl-11"
                  />
                ) : null}
                {it.state === "uploading" || it.state === "finishing" ? <ProgressBar value={it.state === "finishing" ? null : it.pct} label={`Uploading ${it.file.name}`} /> : null}
                {it.error ? <p className="pl-11 text-footnote text-danger">{it.error}</p> : null}
              </li>
            ))}
          </ul>
          {ready.length ? (
            <div className="flex items-center justify-between gap-3 border-t border-line bg-mist/40 px-4 py-3">
              <p className="text-footnote text-ink-2">Check each file’s type so Muse uses it correctly.</p>
              <Button
                size="sm"
                onClick={() => {
                  ready.forEach((it) => void start(it));
                  if (ready.some((i) => NEEDS_CONSENT.has(i.role) && !i.consent)) toast.toast({ title: "Some files need consent", description: "Recordings of a person upload once you confirm consent." });
                }}
              >
                Upload {ready.length} file{ready.length === 1 ? "" : "s"}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
