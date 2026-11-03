"use client";
/**
 * Settings → Phone app: link the MuseLaunch phone app without a password, and see/remove linked
 * phones. "Link your phone" makes a one-time code (POST /v1/me/device-links: 8 characters, 10
 * minutes, single use) shown as a QR code (muselaunch://link?code=…, which also opens the app when
 * scanned with the phone's own camera) and as text to type. While it's shown, the list refreshes so
 * the new phone appears the moment it links. Remove revokes a phone's token at once.
 */
import type { DeviceLinkResponse, DeviceView } from "@muselaunch/contracts";
import { Badge, Button, Notice, Skeleton, useToast } from "@muselaunch/ui";
import { BellOff, Smartphone, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { api, errorMessage } from "@/lib/api";
import { useApiQuery, useInvalidate } from "@/lib/query";

const DEVICES = "/v1/me/devices";

/** The QR code as plain SVG squares (no HTML injection, crisp at any size). */
export function QrCode({ text, size = 184, label }: { text: string; size?: number; label: string }) {
  const qr = useMemo(() => encode(text, { ecc: "M", border: 2 }), [text]);
  const n = qr.size;
  const path = useMemo(() => {
    let d = "";
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) d += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return d;
  }, [qr]);
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="rounded-xl bg-white">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#1d1d1f" />
    </svg>
  );
}

function ago(iso?: string): string {
  if (!iso) return "not used yet";
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

const PLATFORM: Record<DeviceView["platform"], string> = { ios: "iPhone", android: "Android", web: "Browser preview" };

function useCountdown(until: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [until]);
  return until ? Math.max(0, Math.round((Date.parse(until) - now) / 1000)) : 0;
}

export function PhoneAppSettings() {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [link, setLink] = useState<(DeviceLinkResponse & { madeAt: number }) | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const left = useCountdown(link?.expiresAt ?? null);
  const showing = Boolean(link && left > 0);
  const devices = useApiQuery<{ items: DeviceView[] }>(DEVICES, { refetchInterval: showing ? 3000 : false });
  const items = devices.data?.items ?? [];
  const linkedNow = link ? items.find((d) => Date.parse(d.createdAt) >= link.madeAt - 2000) : undefined;

  // The phone used the code: say so and put the code away.
  useEffect(() => {
    if (link && linkedNow) {
      toast.success("Phone linked", `${linkedNow.name} can now review and schedule your posts.`);
      setLink(null);
    }
  }, [link, linkedNow, toast]);

  const makeCode = async () => {
    setBusy("link");
    try {
      const r = await api.post<DeviceLinkResponse>("/v1/me/device-links");
      setLink({ ...r, madeAt: Date.now() });
    } catch (e) {
      toast.error("Couldn’t make a link code", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (d: DeviceView) => {
    if (!window.confirm(`Remove ${d.name}? It stops acting for you right away.`)) return;
    setBusy(d.id);
    try {
      await api.del(`${DEVICES}/${encodeURIComponent(d.id)}`);
      toast.success("Phone removed", `${d.name} is no longer linked.`);
      await invalidate(DEVICES);
    } catch (e) {
      toast.error("Couldn’t remove it", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-4 rounded-xl bg-surface p-5 shadow-raised sm:p-6">
      <div className="space-y-1">
        <p className="text-body font-medium text-ink">MuseLaunch on your phone</p>
        <p className="text-footnote text-ink-2 text-pretty">
          Review and schedule posts, share them to Instagram or TikTok yourself, change them by voice and see your results, with notifications when posts are ready. No password on the phone: link it here.
        </p>
      </div>

      {showing && link ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl bg-mist/70 p-5 sm:flex-row sm:items-start sm:gap-6">
          <QrCode text={link.qr} label={`QR code to link your phone. Code ${link.code}`} />
          <div className="min-w-0 flex-1 space-y-3 text-center sm:text-left">
            <ol className="list-decimal space-y-1 pl-5 text-left text-body-sm text-ink-2">
              <li>Open the MuseLaunch app on your phone.</li>
              <li>Tap “Scan the QR code” and point it here, or type the code.</li>
            </ol>
            <p className="font-mono text-title-2 font-semibold tracking-[0.18em] text-ink" aria-label={`Code ${link.code.split("").join(" ")}`}>
              {link.code}
            </p>
            <p className="text-footnote text-ink-2" aria-live="polite">
              Works once · {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} left · waiting for your phone…
            </p>
            <div className="flex flex-wrap justify-center gap-2 sm:justify-start">
              <Button variant="outline" size="sm" icon={<X className="size-3.5" aria-hidden />} onClick={() => setLink(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          {link && left === 0 ? <Notice tone="warning">That code expired. Make a new one.</Notice> : null}
          <Button size="lg" icon={<Smartphone className="size-4" aria-hidden />} loading={busy === "link"} onClick={() => void makeCode()}>
            Link your phone
          </Button>
        </div>
      )}

      <div className="space-y-2 border-t border-line pt-4">
        <p className="text-footnote font-medium text-ink-2">Linked phones</p>
        {devices.isLoading ? (
          <Skeleton className="h-14 w-full" rounded="lg" />
        ) : devices.error ? (
          <Notice tone="warning">Couldn’t load your phones: {errorMessage(devices.error)}</Notice>
        ) : items.length ? (
          <ul className="divide-y divide-line">
            {items.map((d) => (
              <li key={d.id} className="flex items-center gap-3 py-3">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
                  <Smartphone className="size-4" aria-hidden />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-body-sm font-medium text-ink">{d.name}</span>
                    {!d.notifications.enabled ? (
                      <Badge tone="neutral">
                        <BellOff className="mr-1 size-3" aria-hidden />
                        Notifications off
                      </Badge>
                    ) : null}
                  </span>
                  <span className="block text-caption text-ink-2">
                    {PLATFORM[d.platform]} · linked {new Date(d.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · last used {ago(d.lastUsedAt)}
                  </span>
                </span>
                <Button variant="ghost" size="sm" loading={busy === d.id} onClick={() => void remove(d)} aria-label={`Remove ${d.name}`}>
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-body-sm text-ink-2">No phones linked yet.</p>
        )}
        <p className="text-caption text-ink-3 text-pretty">A link lasts 90 days. Removing a phone signs it out at once. A phone can’t link other phones or invite people.</p>
      </div>
    </div>
  );
}
