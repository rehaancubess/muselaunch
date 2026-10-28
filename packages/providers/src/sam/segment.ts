import {
  buildObjectPrompt,
  formats,
  recordsOfKind,
  type BuildObjectPromptOptions,
  type ResponseStreamOutcome,
  type SegmentationMask,
  type SegmentationResult,
} from "@meta-sam/parser";
import { AppError, type Platform } from "@muselaunch/platform";
import { metaClient, type CallContext } from "../meta/client";
import { samCost } from "../pricing";

/**
 * SAM 3.1 via the Meta Responses API (https://dev.meta.ai/docs/sam/segmenting).
 *
 * Request: one user message with an `input_text` part (concept noun phrase, or box/point object
 * prompts built with `buildObjectPrompt`) and one media part (`input_image.image_url` as URL/data URL,
 * or `input_video.file_id` from the Files API). We always stream (`stream: true`, recommended for
 * video) and parse the special-token output with Meta's `@meta-sam/parser`.
 *
 * Output: one line per frame `<Nf>` with `id<|box;x1;y1;x2;y2;w;h;c|><|mask;x=0;y=0;c;data=H,W,!…|>`
 * records. Boxes are inclusive source pixels; the mask raster covers the box (half-open `bounds`).
 * SAM returns geometry only: compositing happens downstream (mattes/cutouts → HyperFrames).
 */

export type SamMedia = { kind: "image"; imageUrl: string } | { kind: "video"; fileId: string } | { kind: "video"; videoUrl: string };

export type SamPrompt =
  | { kind: "text"; text: string }
  /** Box/point prompts (`buildObjectPrompt` options; sizes are the media's displayed pixel size). */
  | { kind: "objects"; options: BuildObjectPromptOptions };

export interface SamRequest {
  media: SamMedia;
  prompt: SamPrompt;
  /** Source frame count (video) for metering (`frames`) and the spend estimate; billed with a 50-frame minimum. */
  frameCount?: number;
  /** Video + box/point prompts only. Default `both`. */
  propagation?: "both" | "forward" | "backward";
  /** Called as frame lines arrive (count of frame lines parsed so far). */
  onFrames?: (framesEmitted: number) => void;
  /** Overall request timeout (long videos stream for minutes). */
  timeoutMs?: number;
}

export interface SamDetection {
  objectId: string;
  /** Zero-based source frame index (images: 0). */
  frame: number;
  /** Half-open source-pixel box the mask raster covers. */
  bounds: { left: number; top: number; right: number; bottom: number };
  mask: SegmentationMask;
  confidence?: number;
}

export interface SamResult {
  media: "image" | "video";
  detections: SamDetection[];
  /** Distinct frame indexes that have at least one detection, ascending. */
  frames: number[];
  objectIds: string[];
  diagnostics: { severity: "warning" | "error"; code: string; message: string }[];
  outcome: ResponseStreamOutcome;
  /** Full special-token output (kept so re-selection never re-calls SAM). */
  rawOutput: string;
  model: string;
}

/** Concept prompts must be a short noun phrase (docs + SAM 3 paper): strip command phrasing. */
export function normaliseConceptPrompt(raw: string): string {
  let t = raw.trim().replace(/\s+/g, " ").toLowerCase();
  t = t.replace(/^(please\s+)?(segment|select|mask|cut ?out|isolate|track|find|remove the background (from|of|around))\s+/, "");
  t = t.replace(/^(the|a|an)\s+/, "");
  t = t.replace(/[.?!]+$/, "");
  return t.slice(0, 120);
}

/** Convert a parser result into flat detections (shared by the stream path and fixtures). */
export function toSamResult(result: SegmentationResult, model: string): SamResult {
  const boxes = recordsOfKind(result.records, "box");
  const confidenceByKey = new Map<string, number>();
  for (const b of boxes) if (b.confidence !== undefined) confidenceByKey.set(`${b.frame?.frameIndex ?? 0}:${b.objectId}`, b.confidence);
  const detections: SamDetection[] = recordsOfKind(result.records, "mask").map((m) => {
    const frame = m.frame?.frameIndex ?? 0;
    return {
      objectId: m.objectId,
      frame,
      bounds: { ...m.bounds },
      mask: m.mask,
      confidence: m.confidence ?? confidenceByKey.get(`${frame}:${m.objectId}`),
    };
  });
  const frames = [...new Set(detections.map((d) => d.frame))].sort((a, b) => a - b);
  const objectIds = [...new Set(detections.map((d) => d.objectId))].sort((a, b) => Number(a) - Number(b) || a.localeCompare(b));
  return {
    media: result.media,
    detections,
    frames,
    objectIds,
    diagnostics: result.diagnostics.map((d) => ({ severity: d.severity, code: d.code, message: d.message })),
    outcome: result.outcome,
    rawOutput: result.rawOutput,
    model,
  };
}

/** Parse complete SAM output text (stored raw output, non-streamed responses, fixtures). */
export function parseSamOutput(text: string, media: "image" | "video", model = "sam-3.1"): SamResult {
  const parser = (media === "image" ? formats.segmentation.image() : formats.segmentation.video()).createParser();
  parser.push(text.endsWith("\n") ? text : `${text}\n`, { emit: false });
  const { result } = parser.finish({ status: "completed" });
  return toSamResult(result as SegmentationResult, model);
}

/** Responses usage for SAM (docs: api-reference/responses/schemas `ResponseUsage`). */
type SamUsage = { video_frames_processed?: number; images_processed?: number };
type StreamEvent = {
  type: string;
  delta?: unknown;
  text?: unknown;
  item_id?: unknown;
  output_index?: unknown;
  content_index?: unknown;
  message?: unknown;
  response?: { error?: { message?: string } | null; incomplete_details?: { reason?: string | null } | null; usage?: SamUsage | null };
};

/** Billable units: the server's `video_frames_processed` / `images_processed` when reported, else our estimate. */
export function samBilledUnits(media: "image" | "video", usage: SamUsage | null | undefined, estimatedFrames: number): { units: number; reported: boolean } {
  const n = media === "video" ? usage?.video_frames_processed : usage?.images_processed;
  if (typeof n === "number" && Number.isFinite(n) && n >= 0) return { units: n, reported: true };
  return { units: media === "video" ? estimatedFrames : 1, reported: false };
}

/**
 * Run SAM 3.1. Metered (`operation: segmentation`, `frames` for video, `images` for stills); throws
 * AppError on provider errors. Zero matches is a valid result (empty detections), not an error.
 */
export async function runSam(p: Platform, ctx: CallContext, req: SamRequest): Promise<SamResult> {
  const client = metaClient(p);
  const model = client.models.sam;
  const mediaKind = req.media.kind;
  const frames = mediaKind === "video" ? Math.max(1, req.frameCount ?? 1) : 1;
  const text = req.prompt.kind === "text" ? normaliseConceptPrompt(req.prompt.text) : buildObjectPrompt(req.prompt.options);
  if (!text) throw new AppError("BAD_REQUEST", "Empty SAM prompt", { userMessage: "Describe what to select, e.g. “person” or “phone”." });
  const mediaPart =
    req.media.kind === "image"
      ? { type: "input_image", image_url: req.media.imageUrl }
      : "fileId" in req.media
        ? { type: "input_video", file_id: req.media.fileId }
        : { type: "input_video", video_url: req.media.videoUrl };
  const metadata: Record<string, string> = { include_confidence: "true", mask_encoding: "one_bit" };
  if (mediaKind === "video" && req.prompt.kind === "objects") metadata.propagation_direction = req.propagation ?? "both";
  const body = {
    model,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text }, mediaPart] }],
    stream: true,
    metadata,
  };

  return client.metered(ctx, { model, operation: "segmentation", estimatedUsd: samCost(mediaKind, frames) }, async () => {
    const stream = (await client.openai.responses.create(body as never, {
      signal: ctx.signal,
      timeout: req.timeoutMs ?? 30 * 60_000,
    })) as unknown as AsyncIterable<StreamEvent>;
    const parser = (mediaKind === "image" ? formats.segmentation.image() : formats.segmentation.video()).createParser();
    let lane: string | undefined;
    let sawDelta = false;
    let lines = 0;
    let outcome: ResponseStreamOutcome | undefined;
    let usage: SamUsage | null | undefined;
    for await (const ev of stream) {
      const laneKey = `${String(ev.item_id ?? "")}:${String(ev.output_index ?? "")}:${String(ev.content_index ?? "")}`;
      if (ev.type === "response.output_text.delta") {
        lane ??= laneKey;
        if (laneKey !== lane) continue; // SAM emits a single output_text lane; ignore anything else.
        const delta = typeof ev.delta === "string" ? ev.delta : "";
        sawDelta = true;
        parser.push(delta, { emit: false });
        const nl = delta.split("\n").length - 1;
        if (nl > 0) {
          lines += nl;
          req.onFrames?.(lines);
        }
      } else if (ev.type === "response.output_text.done") {
        if (!sawDelta && typeof ev.text === "string") parser.push(`${ev.text}\n`, { emit: false });
      } else if (ev.type === "response.refusal.delta" || ev.type === "response.refusal.done") {
        throw new AppError("PROVIDER_ERROR", "SAM refused the request", { userMessage: "The segmentation model declined this request." });
      } else if (ev.type === "response.completed") {
        outcome = { status: "completed" };
        usage = ev.response?.usage;
      } else if (ev.type === "response.incomplete") {
        outcome = { status: "incomplete", reason: "response", detail: ev.response?.incomplete_details?.reason ?? undefined };
      } else if (ev.type === "response.failed") {
        throw new AppError("PROVIDER_ERROR", `SAM failed: ${ev.response?.error?.message ?? "unknown error"}`);
      } else if (ev.type === "error") {
        throw new AppError("PROVIDER_ERROR", `SAM stream error: ${String(ev.message ?? "unknown")}`, { retryable: true });
      }
    }
    if (!outcome) {
      throw new AppError("PROVIDER_UNAVAILABLE", "SAM stream ended before completion", { retryable: true });
    }
    if (outcome.status !== "completed") {
      throw new AppError("PROVIDER_ERROR", `SAM response incomplete${outcome.detail ? `: ${outcome.detail}` : ""}`, { retryable: false });
    }
    const { result } = parser.finish(outcome);
    const parsed = toSamResult(result as SegmentationResult, model);
    const errors = parsed.diagnostics.filter((d) => d.severity === "error");
    if (errors.length && !parsed.detections.length) {
      throw new AppError("PROVIDER_ERROR", `SAM output could not be parsed: ${errors[0]!.code} ${errors[0]!.message}`);
    }
    const billed = samBilledUnits(mediaKind, usage, frames);
    const cost = mediaKind === "video" ? samCost("video", billed.units) : samCost("image") * billed.units;
    return {
      value: parsed,
      usage: {
        provider: "meta",
        model,
        operation: "segmentation",
        images: mediaKind === "image" ? billed.units : undefined,
        frames: mediaKind === "video" ? billed.units : undefined,
        costUsdEstimate: cost,
        dataMode: "standard",
      },
      trace: {
        // Data URLs are truncated by the trace redactor; file ids / URLs are kept for audit.
        request: body,
        response: {
          outcome,
          usage: usage ?? null,
          billedUnitsSource: billed.reported ? "server_usage" : "estimate",
          frameLines: lines,
          framesWithDetections: parsed.frames.length,
          objectIds: parsed.objectIds,
          diagnostics: parsed.diagnostics.slice(0, 20),
          rawOutputPreview: parsed.rawOutput.slice(0, 1500),
        },
      },
    };
  });
}
