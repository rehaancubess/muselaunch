"use client";
/**
 * The daily chart on Results: one series (views, else link clicks) in the accent colour, real daily
 * numbers only. A day without a number breaks the line (never drawn as 0); a lone measured day is a
 * dot. Same chart language as the app's other chart (Settings → Credits, DailyCostChart): plain SVG,
 * hairline gridlines, ink-3 11px labels, an ink tooltip. Drawn at the container's real width so
 * labels stay readable on a phone. The hidden table is its accessible view.
 */
import type { ResultsSeries } from "@muselaunch/contracts";
import { useEffect, useId, useRef, useState } from "react";
import { chartModel, fullNumber, shortDate, shortNumber } from "./results-lines";

const HEIGHT = 180;
const PAD = { l: 36, r: 12, t: 12, b: 26 };

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(Math.round(el.getBoundingClientRect().width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

export function DailyChart({ series }: { series: ResultsSeries }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const gradient = useId().replace(/:/g, "");
  const words = series.metric === "views" ? "views" : "link clicks";
  const measured = series.points.filter((p) => p.value !== null);
  const peak = measured.reduce<(typeof measured)[number] | null>((a, b) => (a && a.value! >= b.value! ? a : b), null);
  const first = series.points[0];
  const last = series.points.at(-1);
  const summary = `${series.label} per day${first && last ? `, ${shortDate(first.date)} to ${shortDate(last.date)}` : ""}: ${series.measuredDays} day${series.measuredDays === 1 ? "" : "s"} with a number${peak ? `, highest ${fullNumber(peak.value!)} on ${shortDate(peak.date)}` : ""}.`;

  const m = width ? chartModel(series.points, { width, height: HEIGHT, pad: PAD }) : null;
  const point = (i: number) => series.points[i]!;
  const nearest = (clientX: number, rect: DOMRect) => {
    if (!m) return null;
    const x = clientX - rect.left;
    let best = 0;
    for (let i = 1; i < m.xs.length; i++) if (Math.abs(m.xs[i]! - x) < Math.abs(m.xs[best]! - x)) best = i;
    return best;
  };
  const h = hover !== null && m && hover < series.points.length ? { x: m.xs[hover]!, p: point(hover) } : null;

  return (
    <div ref={ref} className="relative w-full" onPointerLeave={(e) => e.pointerType === "mouse" && setHover(null)}>
      {m ? (
        <svg width={width} height={HEIGHT} viewBox={`0 0 ${width} ${HEIGHT}`} role="img" aria-label={summary} className="block touch-pan-y select-none">
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" style={{ stopColor: "var(--ml-accent)" }} stopOpacity={0.16} />
              <stop offset="100%" style={{ stopColor: "var(--ml-accent)" }} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          {/* Hairline gridlines: the top value and the baseline. */}
          <line x1={PAD.l} x2={width - PAD.r} y1={m.y(m.max)} y2={m.y(m.max)} className="stroke-line" strokeWidth={1} />
          <line x1={PAD.l} x2={width - PAD.r} y1={m.baseline} y2={m.baseline} className="stroke-line-strong" strokeWidth={1} />
          <text x={PAD.l - 8} y={m.y(m.max) + 4} textAnchor="end" className="fill-ink-3 text-[11px] tabular-nums">
            {shortNumber(m.max)}
          </text>
          <text x={PAD.l - 8} y={m.baseline + 4} textAnchor="end" className="fill-ink-3 text-[11px] tabular-nums">
            0
          </text>
          {m.areas.map((d) => (
            <path key={d} d={d} fill={`url(#${gradient})`} />
          ))}
          {m.lines.map((d) => (
            <path key={d} d={d} fill="none" className="stroke-accent" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {m.dots.map((d) => (
            <circle key={d.i} cx={d.x} cy={d.y} r={4} className="fill-accent stroke-surface" strokeWidth={2} />
          ))}
          {m.ticks.map((t, k) => (
            <text key={t.i} x={t.x} y={HEIGHT - 6} textAnchor={k === 0 && m.ticks.length > 1 ? "start" : k === m.ticks.length - 1 && m.ticks.length > 1 ? "end" : "middle"} className="fill-ink-3 text-[11px]">
              {t.label}
            </text>
          ))}
          {h ? (
            <g aria-hidden>
              <line x1={h.x} x2={h.x} y1={PAD.t} y2={m.baseline} className="stroke-ink-3" strokeWidth={1} />
              {h.p.value !== null ? <circle cx={h.x} cy={m.y(h.p.value)} r={4.5} className="fill-accent stroke-surface" strokeWidth={2} /> : null}
            </g>
          ) : null}
          {/* The hit area is the whole plot: the crosshair snaps to the nearest day. */}
          <rect
            x={0}
            y={0}
            width={width}
            height={HEIGHT}
            fill="transparent"
            onPointerMove={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
            onPointerDown={(e) => setHover(nearest(e.clientX, e.currentTarget.getBoundingClientRect()))}
          />
        </svg>
      ) : (
        <div style={{ height: HEIGHT }} aria-hidden />
      )}
      {h && m ? (
        <div
          className="pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-ink px-2.5 py-1.5 text-footnote text-white shadow-float"
          style={{ left: Math.min(Math.max(h.x, 70), width - 70) }}
          aria-hidden
        >
          <span className="font-medium">{shortDate(h.p.date)}</span> · {h.p.value === null ? "No number that day" : `${fullNumber(h.p.value)} ${words}`}
        </div>
      ) : null}
      <div className="sr-only">
        <table>
          <caption>{summary}</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">{series.label}</th>
            </tr>
          </thead>
          <tbody>
            {series.points.map((p) => (
              <tr key={p.date}>
                <td>{shortDate(p.date)}</td>
                <td>{p.value === null ? "No number" : fullNumber(p.value)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
