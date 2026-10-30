/**
 * Spark watches the rendered video (job `video.review`): frames sampled from the real MP4 (FFmpeg,
 * @muselaunch/render/frames) go to Muse Spark (multimodal) with the scene list from the composition
 * document and a rubric; deterministic measurements run alongside. The result is a VideoReview whose
 * findings drive a scene-scoped fix through the existing AI edit path (`composition.edit`).
 *
 * Template-agnostic: everything is read from the document's scenes/layers, never from template ids.
 * Honest: a failed or unavailable review is stored as `failed` with the reason; it is never a pass.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  modelDisplayName,
  VIDEO_REVIEW_CHECKS,
  type Composition,
  type CompositionDoc,
  type CompositionPatch,
  type Job,
  type MediaAsset,
  type VideoReview,
  type VideoReviewCheck,
  type VideoReviewFinding,
  type VideoReviewFrame,
  type VideoReviewSeverity,
} from "@muselaunch/contracts";
import { docHash, totalDuration } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError, assertKeyInWorkspace, toAppError, workspaceKey, type JobContext, type JobResult, type Platform } from "@muselaunch/platform";
import { chooseTextModel, imagePart, metaClient, routedJson, untrusted, type InputPart } from "@muselaunch/providers";
import { extractReviewFrames, planReviewFrames, renderAssetId } from "@muselaunch/render/frames";
import { z } from "zod";
import { loadAppContext } from "../context";
import { engineName, fallbackTo } from "../models";
import { RunRecorder } from "../runs";
import { clip, hashId, uniq } from "../util";
import { blankFrameFindings, frameInFrameFindings, frameStats, readingFindings, repetitionFindings, sceneFacts, type FrameStats, type MeasuredFinding, type SceneFacts } from "./measure";

/** Muse Spark Open takes at most 8 images, so the visible fallback is only offered for short reviews. */
const SPARK_OPEN_MAX_IMAGES = 8;
const SEVERITY_RANK: Record<VideoReviewSeverity, number> = { info: 0, warn: 1, blocker: 2 };
const CHECK_LABEL: Record<VideoReviewCheck, string> = {
  hook_readability: "hook readability",
  legibility: "legibility",
  safe_zone: "safe zone",
  device_frame: "device frame",
  broken_frame: "blank or broken frame",
  repetition: "repetition",
  pacing: "pacing",
  cta: "call to action",
  brand_fit: "brand fit",
  honesty: "honesty",
  other: "other",
};
export const videoCheckLabel = (c: VideoReviewCheck) => CHECK_LABEL[c];

/** Deterministic id of the first review of a render (re-runs get fresh ids). */
export const videoReviewId = (compositionId: string, version: number, renderAssetId: string) => hashId("vrv", compositionId, version, renderAssetId);

export const isTerminalVideoReview = (r: Pick<VideoReview, "status">) => r.status === "succeeded" || r.status === "failed";

// ---------------------------------------------------------------------------
// Which render a review watches
// ---------------------------------------------------------------------------

/**
 * The rendered MP4 for `version`: the given asset, else the version's final render, else its preview
 * render (same deterministic ids as the renderer). Refuses other compositions' renders.
 */
export async function renderForVersion(ws: WorkspaceDb, comp: Composition, version: number, assetId?: string): Promise<{ asset: MediaAsset; quality: "final" | "preview"; doc: CompositionDoc }> {
  const { doc } = await getVersion(ws, comp.id, version);
  if (doc.kind !== "video") throw new AppError("BAD_REQUEST", "Spark video reviews are for videos", { userMessage: "Spark reviews rendered videos. Stills and carousels aren't supported yet." });
  const hash = docHash(doc);
  const matches = (a: MediaAsset | null): a is MediaAsset =>
    !!a && a.kind === "video" && a.status === "ready" && ((a.render?.compositionId === comp.id && a.render.version === version) || a.labels.includes(`doc:${hash.slice(0, 40)}`));
  if (assetId) {
    const a = await ws.collection("mediaAssets").get(assetId);
    if (!matches(a)) throw new AppError("BAD_REQUEST", `Asset ${assetId} is not a ready render of this composition version`, { userMessage: "That file isn't a finished render of this version." });
    return { asset: a, quality: a.render?.quality ?? (a.role === "render" ? "final" : "preview"), doc };
  }
  for (const quality of ["final", "preview"] as const) {
    const a = await ws.collection("mediaAssets").get(renderAssetId(hash, quality, "mp4"));
    if (matches(a)) return { asset: a, quality, doc };
  }
  throw new AppError("CONFLICT", `No render of version ${version}`, { userMessage: "Render this version first (a preview render is enough), then ask Spark to watch it.", details: { reason: "no_render", version } });
}

/** Reviews of a composition, newest first (workspace-scoped). */
export async function videoReviewsFor(ws: WorkspaceDb, compositionId: string, limit = 50): Promise<VideoReview[]> {
  return (await ws.collection("videoReviews").list({ where: [["compositionId", "==", compositionId]], orderBy: { field: "createdAt", dir: "desc" }, limit })).items;
}

/**
 * The review record for a render (status `queued`), reusing a non-failed review of the same render
 * unless `rerun`. Idempotent: the first review of a render has a deterministic id.
 */
export async function ensureVideoReview(
  ws: WorkspaceDb,
  input: { appId: string; compositionId: string; version: number; renderAssetId: string; renderQuality?: "final" | "preview"; requestedFrom: VideoReview["requestedFrom"]; rerun?: boolean },
  actor: string,
): Promise<{ review: VideoReview; created: boolean }> {
  const existing = (await videoReviewsFor(ws, input.compositionId)).filter((r) => r.version === input.version && r.renderAssetId === input.renderAssetId);
  if (!input.rerun) {
    const reuse = existing.find((r) => r.status !== "failed");
    if (reuse) return { review: reuse, created: false };
  }
  const repo = ws.collection("videoReviews");
  const id = existing.length ? repo.newId() : videoReviewId(input.compositionId, input.version, input.renderAssetId);
  const { entity, created } = await repo.createIfAbsent(
    { id, appId: input.appId, compositionId: input.compositionId, version: input.version, renderAssetId: input.renderAssetId, renderQuality: input.renderQuality, status: "queued", requestedFrom: input.requestedFrom, frames: [], findings: [], rubric: [], fixPatchIds: [], summary: "", reviewer: {} },
    { actor },
  );
  return { review: entity, created };
}

export interface RequestVideoReviewInput {
  compositionId: string;
  version?: number;
  renderAssetId?: string;
  rerun?: boolean;
  actor: string;
  requestedFrom: VideoReview["requestedFrom"];
  idempotencyKey?: string;
  parentJobId?: string;
}

/** Create (or reuse) a VideoReview and enqueue `video.review` with the `video.review` credit price reserved. */
export async function requestVideoReview(p: Platform, workspaceId: string, input: RequestVideoReviewInput): Promise<{ review: VideoReview; job: Job | null; reused: boolean }> {
  const ws = p.db.ws(workspaceId);
  const comp = await ws.collection("compositions").getOrThrow(input.compositionId);
  const version = input.version ?? comp.currentVersion;
  const { asset, quality } = await renderForVersion(ws, comp, version, input.renderAssetId);
  const { review, created } = await ensureVideoReview(ws, { appId: comp.appId, compositionId: comp.id, version, renderAssetId: asset.id, renderQuality: quality, requestedFrom: input.requestedFrom, rerun: input.rerun }, input.actor);
  if (!created) return { review, job: review.jobId ? await p.jobs.get(workspaceId, review.jobId) : null, reused: true };
  let job: Job;
  try {
    job = await p.jobs.create(
      workspaceId,
      "video.review",
      { appId: comp.appId, compositionId: comp.id, version, renderAssetId: asset.id, reviewId: review.id },
      { actor: input.actor, appId: comp.appId, idempotencyKey: input.idempotencyKey ?? `video.review:${review.id}`, credits: { operation: "video.review" }, parentJobId: input.parentJobId },
    );
  } catch (err) {
    await ws.collection("videoReviews").delete(review.id).catch(() => {});
    throw err;
  }
  const fresh = (await ws.collection("videoReviews").get(review.id)) ?? review;
  return { review: fresh.jobId ? fresh : await ws.collection("videoReviews").update(review.id, { jobId: job.id }, { actor: input.actor }), job, reused: false };
}

// ---------------------------------------------------------------------------
// Prompt + output
// ---------------------------------------------------------------------------

/** Wire format from Spark; normalised (unknown checks → other, severities, ids) before storing. */
export const VideoReviewDraft = z.object({
  score: z.number().min(0).max(10).describe("Overall 0-10: 10 = ready to publish as is"),
  summary: z.string().min(1).max(3000).describe("Two or three sentences on what a viewer experiences"),
  rubric: z
    .array(z.object({ check: z.string().max(40), verdict: z.string().max(20).describe("ok | issue | unclear"), note: z.string().max(1000).optional() }))
    .max(20)
    .default([])
    .describe(`One entry per rubric check: ${VIDEO_REVIEW_CHECKS.filter((c) => c !== "other").join(", ")}`),
  findings: z
    .array(
      z.object({
        sceneId: z.string().max(128).describe('A scene id from the scene list, or "video" for an issue with the whole video'),
        severity: z.string().max(20).describe("blocker | warn | info"),
        check: z.string().max(40).describe(`One of: ${VIDEO_REVIEW_CHECKS.join(", ")}`),
        issue: z.string().min(1).max(2000).describe("What a viewer sees, citing the frame (e.g. f3)"),
        fixInstruction: z.string().min(1).max(2000).describe("A concrete edit for this scene only"),
        frameRef: z.string().max(12).default("").describe("Frame that shows it (f1, f2…), or empty"),
      }),
    )
    .max(30)
    .default([]),
});
export type VideoReviewDraft = z.infer<typeof VideoReviewDraft>;

export const VIDEO_REVIEW_INSTRUCTIONS = `You are Muse Spark acting as MuseLaunch's video reviewer. You are shown frames sampled from a RENDERED short marketing video (exactly what viewers will see), the scene list of the editable composition it was rendered from, and deterministic measurements. Judge the pixels, not the plan: report only what the frames show or the measurements prove.

Rubric (give each a verdict: ok, issue, or unclear when the frames can't show it):
- hook_readability: the opening text must be readable in the time it is on screen (about 3 words per second; use the measured reading speed).
- legibility: text has strong contrast with what is behind it, is large enough on a phone, and nothing is cut off, overflowing or outside the frame.
- safe_zone: important text and UI stay clear of the platform UI zones given below.
- device_frame: never a device frame inside another device frame (e.g. a store screenshot that already shows a phone, placed inside our phone mockup); no stretched or distorted screens.
- broken_frame: no blank, black or flat frames, missing media, empty placeholder boxes or rendering glitches (a fade-in on the very first frame is acceptable only if the hook appears quickly).
- repetition: the same visual (same screenshot or same-looking scene) shown 3 or more times.
- pacing: variety between scenes; nothing on screen too briefly to take in or so long it drags.
- cta: a clear, readable call to action near the end.
- brand_fit: colours, typography and tone consistent with the brand notes.
- honesty: no statistics, ratings, reviews, testimonials, awards or user counts visible unless they are in the verified claims list.

Severity:
- blocker: viewers would see something broken or misleading, or miss the message: unreadable hook, cut-off text, a device frame inside a device frame, a blank or broken frame, no call to action, an invented claim.
- warn: a real weakness worth fixing: low contrast, repetition, monotonous pacing, a safe-zone intrusion.
- info: a minor suggestion.

For each finding give sceneId (from the scene list, or "video" for the whole video), check, issue (what you see, citing the frame ref such as f3), fixInstruction (a concrete edit a scene editor can make inside that scene only, e.g. "Shorten the headline to 'Focus in one tap' or extend this scene to 3.5 s", "Show the store image without the phone frame", "Put the headline on a dark scrim for contrast") and frameRef.
Never invent problems you can't see. Do not repeat the same problem for several frames of one scene. Score 0-10 (10 = ready to publish as is).`;

function brandNotes(ctx: Awaited<ReturnType<typeof loadAppContext>>): string {
  const d = ctx.dna;
  if (!d) return `${ctx.app.name}: no App DNA yet.`;
  return [
    `App: ${ctx.app.name} — ${d.oneLiner}`,
    d.visual.palette.length ? `Palette: ${d.visual.palette.map((c) => `${c.hex}${c.role ? ` (${c.role})` : ""}`).join(", ")}` : "",
    d.visual.styleKeywords.length ? `Visual style: ${d.visual.styleKeywords.join(", ")}` : "",
    d.tone.voice.length ? `Voice: ${d.tone.voice.join(", ")}${d.tone.vocabularyAvoid.length ? ` (avoid: ${d.tone.vocabularyAvoid.join(", ")})` : ""}` : "",
    d.prohibitedClaims.length ? `Prohibited claims: ${d.prohibitedClaims.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const sec = (n: number) => `${(Math.round(n * 100) / 100).toFixed(2)}s`;

/** The text part of the review request (scene list, measurements, claims, frame list). */
export function reviewPromptText(input: {
  title: string;
  version: number;
  doc: CompositionDoc;
  quality: "final" | "preview";
  facts: SceneFacts[];
  frames: VideoReviewFrame[];
  measured: MeasuredFinding[];
  verifiedClaims: string[];
  brand: string;
}): string {
  const { doc, facts } = input;
  const sz = doc.safeZone;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const sceneLines = facts.map((f) => {
    const texts = f.texts.map((t) => `"${clip(t.text, 160)}"`).join(" / ");
    return `- ${f.id} | ${f.name} | template ${f.template}${f.purpose ? ` (${f.purpose})` : ""} | ${sec(f.startSec)}–${sec(f.startSec + f.durationSec)} (${sec(f.durationSec)}) | text: ${texts || "(none)"}${f.wps ? ` | ${f.words} words, ${f.wps} words/s while readable` : ""}`;
  });
  const frameLines = input.frames.map((fr) => {
    const f = facts.find((x) => x.id === fr.sceneId);
    return `Frame ${fr.ref}: ${sec(fr.atSec)} — ${fr.kind === "first" ? "very first frame" : fr.kind === "mid" ? "scene mid-point" : fr.kind === "early" ? "early in a long scene" : "late in a long scene"}${f ? ` — scene ${f.id} "${f.name}" (${sec(fr.atSec - f.startSec)} into it)` : ""}`;
  });
  return [
    `Video "${clip(input.title, 120)}", composition version ${input.version}: ${doc.aspectRatio} ${doc.width}×${doc.height}, ${sec(totalDuration(doc))}, rendered as a ${input.quality} MP4.`,
    `Platform UI zones to keep clear: top ${pct(sz.top)}, bottom ${pct(sz.bottom)}, left ${pct(sz.left)}, right ${pct(sz.right)}.`,
    `Captions: ${doc.captions.enabled ? `on (${doc.captions.preset}, ${doc.captions.position})` : "off"}.`,
    "",
    "Scenes (id | name | template | start–end (duration) | on-screen text):",
    untrusted("composition_scenes", sceneLines.join("\n"), 12_000),
    "",
    "Measurements (deterministic, from the composition and the frames' pixels):",
    input.measured.length ? input.measured.map((m) => `- [${m.check}${m.sceneId ? ` · ${m.sceneId}` : ""}] ${m.issue} (${m.measurement})`).join("\n") : "- nothing flagged",
    "",
    "Verified claims (the only product facts the video may state):",
    untrusted("verified_claims", input.verifiedClaims.length ? input.verifiedClaims.map((c) => `- ${c}`).join("\n") : "- (none verified)", 4000),
    "",
    "Brand notes:",
    untrusted("brand", input.brand, 2000),
    "",
    `Frames attached, in this order (${input.frames.length}):`,
    ...frameLines,
  ].join("\n");
}

const normCheck = (c: string): VideoReviewCheck => {
  const k = c.toLowerCase().trim().replace(/[\s-]+/g, "_");
  if ((VIDEO_REVIEW_CHECKS as readonly string[]).includes(k)) return k as VideoReviewCheck;
  if (/hook/.test(k)) return "hook_readability";
  if (/safe/.test(k)) return "safe_zone";
  if (/device|frame_in|mockup/.test(k)) return "device_frame";
  if (/blank|black|broken|glitch/.test(k)) return "broken_frame";
  if (/repe|duplicat/.test(k)) return "repetition";
  if (/pac|tim|rhythm/.test(k)) return "pacing";
  if (/cta|call/.test(k)) return "cta";
  if (/brand|colou?r|font|typo/.test(k)) return "brand_fit";
  if (/honest|claim|stat|review|testimon/.test(k)) return "honesty";
  if (/legib|contrast|read|text|cut/.test(k)) return "legibility";
  return "other";
};
const normSeverity = (s: string): VideoReviewSeverity => (/block|critical|high/i.test(s) ? "blocker" : /warn|medium|major/i.test(s) ? "warn" : "info");
const normVerdict = (s: string): "ok" | "issue" | "unclear" => (/^ok|pass|good|fine/i.test(s.trim()) ? "ok" : /unclear|unknown|n\/?a/i.test(s) ? "unclear" : "issue");

/**
 * Spark's draft → stored findings: known scene ids and frame refs only, normalised checks/severities,
 * one finding per scene + check, then the measurements Spark didn't report itself (a matching Spark
 * finding is raised to the measured severity instead of duplicated).
 */
export function mergeVideoFindings(
  reviewId: string,
  draft: Pick<VideoReviewDraft, "findings">,
  ctx: { sceneIds: string[]; frames: VideoReviewFrame[]; measured: MeasuredFinding[] },
): { findings: VideoReviewFinding[]; dropped: string[] } {
  const scenes = new Set(ctx.sceneIds);
  const refs = new Map(ctx.frames.map((f) => [f.ref, f]));
  const dropped: string[] = [];
  const out: VideoReviewFinding[] = [];
  for (const f of draft.findings) {
    const frameRef = refs.has(f.frameRef.trim()) ? f.frameRef.trim() : undefined;
    let sceneId: string | undefined = scenes.has(f.sceneId) ? f.sceneId : undefined;
    if (!sceneId && f.sceneId && !/^(video|whole|all|none|-)$/i.test(f.sceneId.trim())) {
      sceneId = frameRef ? refs.get(frameRef)?.sceneId : undefined;
      dropped.push(`unknown scene "${clip(f.sceneId, 60)}"${sceneId ? ` → ${sceneId} (from ${frameRef})` : " → whole video"}`);
    }
    const check = normCheck(f.check);
    const severity = normSeverity(f.severity);
    const same = out.find((x) => x.sceneId === sceneId && x.check === check);
    if (same) {
      if (SEVERITY_RANK[severity] > SEVERITY_RANK[same.severity]) same.severity = severity;
      continue;
    }
    out.push({ id: "", sceneId, severity, check, issue: clip(f.issue, 600), fixInstruction: clip(f.fixInstruction, 600), frameRef, source: "spark" });
  }
  for (const m of ctx.measured) {
    const same = out.find((x) => x.sceneId === m.sceneId && x.check === m.check);
    if (same) {
      if (SEVERITY_RANK[m.severity] > SEVERITY_RANK[same.severity]) same.severity = m.severity;
      same.measurement = clip(m.measurement, 200);
      continue;
    }
    out.push({ id: "", sceneId: m.sceneId, severity: m.severity, check: m.check, issue: clip(m.issue, 600), fixInstruction: clip(m.fixInstruction, 600), frameRef: m.frameRef, source: "measured", measurement: clip(m.measurement, 200) });
  }
  const order = (f: VideoReviewFinding) => (f.sceneId ? ctx.sceneIds.indexOf(f.sceneId) : -1);
  const sorted = out.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || order(a) - order(b)).slice(0, 60);
  return { findings: sorted.map((f, i) => ({ ...f, id: `vf_${hashId("x", reviewId, i, f.check, f.sceneId).slice(2, 14)}` })), dropped };
}

export function videoVerdictOf(findings: Pick<VideoReviewFinding, "severity">[]): NonNullable<VideoReview["verdict"]> {
  return findings.some((f) => f.severity === "blocker") ? "blockers" : findings.some((f) => f.severity === "warn") ? "warnings" : "pass";
}

/** "6.5/10 · 2 blockers, 1 warning" */
export function videoReviewLine(r: Pick<VideoReview, "score" | "findings">): string {
  const n = (s: VideoReviewSeverity) => r.findings.filter((f) => f.severity === s).length;
  const b = n("blocker");
  const w = n("warn");
  return `${r.score !== undefined ? `${r.score}/10` : "no score"} · ${b ? `${b} blocker${b === 1 ? "" : "s"}` : "no blockers"}${w ? `, ${w} warning${w === 1 ? "" : "s"}` : ""}`;
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

interface LoadedFrames {
  frames: VideoReviewFrame[];
  buffers: Map<string, Buffer>;
  reused: boolean;
}

const frameAssetId = (reviewId: string, ref: string) => hashId("ast", "vrf", reviewId, ref);

/** Frames already stored for this review (job retry), or extract them from the MP4 and store them as derived assets. */
async function loadFrames(ctx: JobContext<"video.review">, review: VideoReview, comp: Composition, render: MediaAsset, doc: CompositionDoc, facts: SceneFacts[]): Promise<LoadedFrames> {
  const p = ctx.platform;
  if (review.frames.length && review.frames.every((f) => f.assetId)) {
    const assets = await ctx.ws.collection("mediaAssets").getMany(review.frames.map((f) => f.assetId!));
    const buffers = new Map<string, Buffer>();
    for (const f of review.frames) {
      const a = assets.find((x) => x.id === f.assetId);
      if (!a) break;
      assertKeyInWorkspace(ctx.workspaceId, a.storagePath);
      const buf = await p.storage.get(a.storagePath).catch(() => null);
      if (!buf) break;
      buffers.set(f.ref, buf);
    }
    if (buffers.size === review.frames.length) return { frames: review.frames, buffers, reused: true };
  }
  const plan = planReviewFrames(
    facts.map((f) => ({ id: f.id, startSec: f.startSec, durationSec: f.durationSec })),
    { totalSec: Math.min(totalDuration(doc), render.durationSec ?? Number.POSITIVE_INFINITY), fps: doc.fps },
  );
  const dir = await mkdtemp(join(tmpdir(), "ml-vreview-"));
  try {
    assertKeyInWorkspace(ctx.workspaceId, render.storagePath);
    const video = join(dir, "render.mp4");
    try {
      await p.storage.downloadToFile(render.storagePath, video);
    } catch (err) {
      throw new AppError("VALIDATION_FAILED", `Render ${render.id} could not be read from storage`, { cause: err, userMessage: "The rendered video is missing. Render it again, then retry." });
    }
    ctx.throwIfCancelled();
    const { frames: extracted } = await extractReviewFrames(video, plan, join(dir, "frames"), { signal: ctx.signal });
    const frames: VideoReviewFrame[] = [];
    const buffers = new Map<string, Buffer>();
    for (const f of extracted) {
      ctx.throwIfCancelled();
      const buf = await readFile(f.path);
      const id = frameAssetId(review.id, f.ref);
      const key = workspaceKey(ctx.workspaceId, "reviews", comp.id, `${review.id}-${f.ref}.jpg`);
      const put = await p.storage.put(key, buf, { contentType: "image/jpeg" });
      await ctx.ws.collection("mediaAssets").createIfAbsent(
        {
          id,
          appId: comp.appId,
          campaignId: comp.campaignId,
          kind: "image",
          role: "preview",
          origin: "derived",
          storagePath: key,
          mimeType: "image/jpeg",
          bytes: put.bytes,
          sha256: put.sha256,
          width: f.width,
          height: f.height,
          status: "ready",
          title: clip(`${comp.title} — frame ${f.ref} at ${f.atSec.toFixed(2)}s (Spark review)`, 200),
          labels: ["review-frame", `t:${f.atSec.toFixed(2)}`, `v:${review.version}`],
          isProductTruth: false,
          sourceLabel: "review_frame",
          license: { type: "owned" },
          derivedFromAssetId: render.id,
        },
        { actor: ctx.actor },
      );
      buffers.set(f.ref, buf);
      frames.push({ ref: f.ref, atSec: f.atSec, sceneId: f.sceneId, kind: f.kind, assetId: id, width: f.width, height: f.height });
    }
    return { frames, buffers, reused: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function imageInputs(p: Platform, ws: WorkspaceDb, workspaceId: string, frames: VideoReviewFrame[], buffers: Map<string, Buffer>): Promise<InputPart[]> {
  if (p.storage.driver !== "gcs") return frames.map((f) => imagePart({ bytes: buffers.get(f.ref)!, mimeType: "image/jpeg" }));
  const assets = await ws.collection("mediaAssets").getMany(frames.map((f) => f.assetId!).filter(Boolean));
  const parts: InputPart[] = [];
  for (const f of frames) {
    const a = assets.find((x) => x.id === f.assetId);
    if (!a) {
      parts.push(imagePart({ bytes: buffers.get(f.ref)!, mimeType: "image/jpeg" }));
      continue;
    }
    assertKeyInWorkspace(workspaceId, a.storagePath);
    parts.push(imagePart({ url: (await p.storage.signedDownloadUrl(a.storagePath, { expiresSec: 900 })).url }));
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Job handler
// ---------------------------------------------------------------------------

export async function videoReviewHandler(ctx: JobContext<"video.review">): Promise<JobResult> {
  const p = ctx.platform;
  const ws = ctx.ws;
  const { appId, compositionId, version, renderAssetId: assetId } = ctx.payload;
  const repo = ws.collection("videoReviews");
  const comp = await ws.collection("compositions").getOrThrow(compositionId);
  if (comp.appId !== appId) throw new AppError("BAD_REQUEST", "Composition belongs to another app");
  const reviewId = ctx.payload.reviewId ?? videoReviewId(compositionId, version, assetId);
  let review = await repo.get(reviewId);
  if (review && (review.compositionId !== compositionId || review.version !== version || review.renderAssetId !== assetId)) throw new AppError("BAD_REQUEST", "This review belongs to another render");
  if (review?.status === "succeeded") return { refs: [{ entity: "videoReviews", id: review.id }], data: { alreadyReviewed: true, verdict: review.verdict }, creditsUsed: 0 };

  const { asset: render, quality, doc } = await renderForVersion(ws, comp, version, assetId);
  if (!review) review = (await ensureVideoReview(ws, { appId, compositionId, version, renderAssetId: render.id, renderQuality: quality, requestedFrom: "api" }, ctx.actor)).review;
  review = await repo.update(review.id, { status: "running", jobId: ctx.job.id, renderQuality: quality, error: undefined }, { actor: ctx.actor });
  const started = Date.now();
  const planned = chooseTextModel(p, "video.review");
  const rec = await RunRecorder.start(ctx, { id: hashId("run", ctx.job.id), kind: "video_review", model: planned.model, goal: clip(`Watch "${comp.title}" v${version} (${quality} render) and review what viewers see`, 4000), appId });
  try {
    // Fail before any media work when nothing can answer (honest: never a pass).
    if (planned.engine === "muse-spark" && !metaClient(p).configured) {
      throw new AppError("PROVIDER_NOT_CONFIGURED", "META_API_KEY is not set", { userMessage: "Muse Spark isn't connected on this deployment, so it can't watch the video. Nothing was reviewed." });
    }
    const facts = sceneFacts(doc);
    await ctx.progress(8, "reading frames from the render");
    const loaded = await loadFrames(ctx, review, comp, render, doc, facts);
    review = await repo.update(review.id, { frames: loaded.frames }, { actor: ctx.actor });
    await rec.step({ kind: "tool_call", title: `${loaded.reused ? "Reused" : "Sampled"} ${loaded.frames.length} frames of the ${quality} render${loaded.reused ? "" : " with FFmpeg"}`, input: { renderAssetId: render.id, durationSec: render.durationSec }, output: loaded.frames.map((f) => `${f.ref} ${f.atSec}s ${f.kind}${f.sceneId ? ` ${f.sceneId}` : ""}`) });
    ctx.throwIfCancelled();

    // Deterministic measurements (document + pixels).
    const stats: FrameStats[] = [];
    for (const f of loaded.frames) {
      const s = await frameStats(loaded.buffers.get(f.ref)!).catch(() => null);
      if (s) stats.push({ ref: f.ref, sceneId: f.sceneId, kind: f.kind, atSec: f.atSec, ...s });
    }
    const assets = new Map((await ws.collection("mediaAssets").getMany(uniq(doc.scenes.flatMap((s) => s.layers.flatMap((l) => (l.type === "device" ? [l.screenAssetId] : l.type === "effect" && l.assetId ? [l.assetId] : [])))))).map((a) => [a.id, a]));
    const measured = [...readingFindings(facts), ...frameInFrameFindings(doc, assets), ...repetitionFindings(facts), ...blankFrameFindings(stats, facts)];
    await rec.step({ kind: "decision", title: measured.length ? `Measured ${measured.length} issue(s) before Spark looked` : "Measurements found nothing to flag", output: measured.map((m) => `${m.check}${m.sceneId ? ` ${m.sceneId}` : ""}: ${m.measurement}`) });

    const app = await loadAppContext(ws, appId);
    const text = reviewPromptText({ title: comp.title, version, doc, quality, facts, frames: loaded.frames, measured, verifiedClaims: app.verifiedClaims.map((c) => c.text), brand: brandNotes(app) });
    const images = await imageInputs(p, ws, ctx.workspaceId, loaded.frames, loaded.buffers);
    await ctx.progress(35, `${planned.name} is watching the video`);
    const out = await routedJson(
      p,
      {
        ctx: rec.callCtx("video.review"),
        model: "spark",
        instructions: VIDEO_REVIEW_INSTRUCTIONS,
        input: [{ type: "input_text", text }, ...images],
        schema: VideoReviewDraft,
        schemaName: "VideoReview",
        maxOutputTokens: 6000,
        reasoningEffort: "medium",
        cacheKey: "agents.video_review",
      },
      { route: "video.review", onFallback: loaded.frames.length <= SPARK_OPEN_MAX_IMAGES ? fallbackTo(rec) : undefined },
    );
    await rec.modelStep(`Watch ${loaded.frames.length} frames and review them (${engineName(out.model)}, multimodal)`, out, { frames: loaded.frames.length, scenes: facts.length, measured: measured.length }, { score: out.data.score, findings: out.data.findings.length });
    ctx.throwIfCancelled();

    const { findings, dropped } = mergeVideoFindings(review.id, out.data, { sceneIds: facts.map((f) => f.id), frames: loaded.frames, measured });
    const rubric = uniq(out.data.rubric.map((r) => normCheck(r.check)))
      .filter((c) => c !== "other")
      .map((check) => {
        const r = out.data.rubric.find((x) => normCheck(x.check) === check)!;
        return { check, verdict: normVerdict(r.verdict), note: r.note ? clip(r.note, 300) : undefined };
      });
    const verdict = videoVerdictOf(findings);
    const score = Math.round(Math.min(10, Math.max(0, out.data.score)) * 10) / 10;
    review = await repo.update(
      review.id,
      {
        status: "succeeded",
        verdict,
        score,
        summary: clip(out.data.summary, 2000),
        findings,
        rubric,
        reviewer: { model: out.model, label: modelDisplayName(out.model), note: out.fallback?.title ? clip(out.fallback.title, 300) : undefined },
        agentRunId: rec.id,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - started,
        error: undefined,
      },
      { actor: ctx.actor },
    );
    await rec.step({ kind: "decision", title: `Verdict: ${verdict} (${videoReviewLine(review)})`, output: { findings: findings.map((f) => `${f.severity} ${f.check}${f.sceneId ? ` ${f.sceneId}` : ""} (${f.source})`), dropped } });
    await rec.finish("succeeded", { outputRefs: [{ entity: "videoReviews", id: review.id }] });
    await ctx.progress(100, verdict === "pass" ? "no problems found" : verdict === "warnings" ? "warnings found" : "blockers found");
    const price = p.credits.estimate("video.review").credits;
    return {
      refs: [{ entity: "videoReviews", id: review.id }, { entity: "agentRuns", id: rec.id }],
      data: { reviewId: review.id, verdict, score, blockers: findings.filter((f) => f.severity === "blocker").length, warnings: findings.filter((f) => f.severity === "warn").length, frames: loaded.frames.length, model: out.model },
      creditsUsed: ctx.job.reservation ? Math.min(price, ctx.job.reservation.credits) : price,
    };
  } catch (raw) {
    const err = toAppError(raw);
    const final = err.code === "CANCELLED" || !err.retryable || ctx.job.attempts >= ctx.job.maxAttempts;
    await repo
      .update(review.id, final ? { status: "failed", error: clip(err.opts.userMessage ?? err.message, 1000), agentRunId: rec.id, latencyMs: Date.now() - started } : { status: "queued", error: clip(`Retrying: ${err.opts.userMessage ?? err.message}`, 1000) }, { actor: ctx.actor })
      .catch(() => {});
    await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fixes (scene-scoped AI edit from findings)
// ---------------------------------------------------------------------------

export interface VideoFixPlan {
  sceneIds: string[];
  instruction: string;
  findings: VideoReviewFinding[];
}

/**
 * The scene-scoped edit for a review's findings: the given findings, or every open finding of the given
 * severities (default blockers and warnings) that names a scene of `doc`. Null when none is fixable
 * scene by scene (whole-video findings need a person).
 */
export function videoFixPlan(review: Pick<VideoReview, "version" | "findings">, doc: CompositionDoc, opts: { findingIds?: string[]; severities?: VideoReviewSeverity[] } = {}): VideoFixPlan | null {
  const sceneOrder = new Map(doc.scenes.map((s, i) => [s.id, i]));
  const wanted = opts.findingIds ? new Set(opts.findingIds) : null;
  const severities = new Set(opts.severities ?? ["blocker", "warn"]);
  const findings = review.findings
    .filter((f) => (wanted ? wanted.has(f.id) : severities.has(f.severity) && !f.resolution))
    .filter((f) => f.sceneId && sceneOrder.has(f.sceneId))
    .sort((a, b) => sceneOrder.get(a.sceneId!)! - sceneOrder.get(b.sceneId!)! || SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  if (!findings.length) return null;
  const sceneIds = uniq(findings.map((f) => f.sceneId!));
  const name = (id: string) => doc.scenes.find((s) => s.id === id)?.name ?? id;
  const head = `Spark watched the rendered video (version ${review.version}) and saw these problems. Fix them by editing only the listed scenes; keep every other scene, the media that isn't mentioned and the brand look unchanged. Use only verified claims.`;
  const lines = findings.map((f) => `- Scene "${clip(name(f.sceneId!), 60)}" (${f.sceneId}) [${f.severity}, ${CHECK_LABEL[f.check]}]: ${clip(f.issue, 300)} Fix: ${clip(f.fixInstruction, 300)}`);
  let instruction = head;
  for (const l of lines) {
    if (instruction.length + l.length + 1 > 2000) break;
    instruction += `\n${l}`;
  }
  return { sceneIds, instruction, findings };
}

/** Record that a fix was requested from these findings (shown in the Studio, linked to the patch). */
export async function markFixRequested(ws: WorkspaceDb, review: VideoReview, findingIds: string[], patchId: string, actor: string): Promise<VideoReview> {
  const at = new Date().toISOString();
  const ids = new Set(findingIds);
  return ws.collection("videoReviews").update(
    review.id,
    { findings: review.findings.map((f) => (ids.has(f.id) ? { ...f, resolution: { state: "fix_requested" as const, patchId, by: actor, at } } : f)), fixPatchIds: uniq([...review.fixPatchIds, patchId]).slice(-20) },
    { actor },
  );
}

/**
 * Studio "Fix these scenes": a PROPOSED scene-scoped AI edit (composition.edit, not auto-applied) built
 * from the findings, reviewed and applied by a person like any other AI edit.
 */
export async function requestVideoFix(
  p: Platform,
  workspaceId: string,
  input: { reviewId: string; findingIds?: string[]; actor: string; idempotencyKey?: string },
): Promise<{ review: VideoReview; patch: CompositionPatch; job: Job }> {
  const ws = p.db.ws(workspaceId);
  const review = await ws.collection("videoReviews").getOrThrow(input.reviewId);
  if (review.status !== "succeeded") throw new AppError("CONFLICT", `Review is ${review.status}`, { userMessage: "Spark hasn't finished this review." });
  const comp = await ws.collection("compositions").getOrThrow(review.compositionId);
  if (comp.currentVersion !== review.version) {
    throw new AppError("CONFLICT", `Review is of version ${review.version}; the composition is at version ${comp.currentVersion}`, {
      userMessage: "The video changed since Spark watched it. Render it and ask Spark to review it again.",
      details: { reason: "video_review_stale", reviewedVersion: review.version, currentVersion: comp.currentVersion },
    });
  }
  const { doc } = await getVersion(ws, comp.id, review.version);
  const unknown = (input.findingIds ?? []).filter((id) => !review.findings.some((f) => f.id === id));
  if (unknown.length) throw new AppError("BAD_REQUEST", `Unknown finding(s): ${unknown.join(", ")}`);
  const plan = videoFixPlan(review, doc, { findingIds: input.findingIds });
  if (!plan) throw new AppError("BAD_REQUEST", "No scene-scoped findings to fix", { userMessage: "These findings are about the whole video, not one scene. Ask Muse to edit the video instead." });
  const patch = await ws.collection("compositionPatches").create(
    { compositionId: comp.id, baseVersion: review.version, ops: [], summary: "Generating fix…", source: "ai", instruction: plan.instruction, affectedSceneIds: plan.sceneIds, status: "proposed", validationErrors: [], memoryRefs: [] },
    { actor: input.actor },
  );
  let job: Job;
  try {
    job = await p.jobs.create(
      workspaceId,
      "composition.edit",
      { appId: comp.appId, compositionId: comp.id, baseVersion: review.version, instruction: plan.instruction, sceneIds: plan.sceneIds, patchId: patch.id, autoApply: false },
      { actor: input.actor, appId: comp.appId, idempotencyKey: input.idempotencyKey ? `${input.idempotencyKey}:${patch.id}` : `video-fix:${patch.id}`, credits: { operation: "composition.edit" } },
    );
  } catch (err) {
    await ws.collection("compositionPatches").update(patch.id, { status: "rejected", summary: "Not started", validationErrors: [clip(toAppError(err).message, 500)] }, { actor: input.actor }).catch(() => {});
    throw err;
  }
  const updated = await markFixRequested(ws, review, plan.findings.map((f) => f.id), patch.id, input.actor);
  return { review: updated, patch, job };
}
