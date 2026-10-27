import { createHash } from "node:crypto";
import { AppError, type Platform } from "@muselaunch/platform";
import type { CallContext } from "../meta/client";
import { PRICES } from "../pricing";
import { httpError, meterExternal } from "./meter";
import type { GeneratedImage, ImageEditInput, ImageGenerateInput, ImageProvider, ImageResult } from "./types";

/**
 * OpenAI Images (Image API: `POST /v1/images/generations`, multipart `POST /v1/images/edits`).
 * Used wherever Muse Image is unavailable (default deployment: operator in India). Every result is
 * labelled with provider + model; cost comes from returned token usage when present.
 *
 * Note: `gpt-image-1` was shut down on 2026-10-23 (OpenAI deprecations page); the documented
 * replacements are `gpt-image-2.5-flare` (fast) and `gpt-image-2.5-sunburst` (edit precision).
 */

/** USD per 1M tokens (developers.openai.com model pages, verified 2026-10-27). Unknown models fall back to a flat per-image estimate. */
const TOKEN_PRICES: Record<string, { textIn: number; imageIn: number; imageOut: number }> = {
  "gpt-image-2.5-flare": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-2.5-flare-2026-09-08": { textIn: 5, imageIn: 8, imageOut: 30 },
  "gpt-image-1": { textIn: 5, imageIn: 10, imageOut: 40 },
};
export const OPENAI_IMAGES_TERMS_URL = "https://openai.com/policies/terms-of-use/";

interface OpenAiImagesResponse {
  created?: number;
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  output_format?: "png" | "jpeg" | "webp";
  usage?: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { text_tokens?: number; image_tokens?: number } };
}

export function openAiImageCost(model: string, n: number, usage?: OpenAiImagesResponse["usage"]): number {
  const price = TOKEN_PRICES[model];
  if (price && usage && typeof usage.output_tokens === "number") {
    const text = usage.input_tokens_details?.text_tokens ?? usage.input_tokens ?? 0;
    const image = usage.input_tokens_details?.image_tokens ?? 0;
    return (text * price.textIn + image * price.imageIn + usage.output_tokens * price.imageOut) / 1_000_000;
  }
  return n * PRICES.openaiImagePerImage;
}

const safetyId = (workspaceId: string) => createHash("sha256").update(`muselaunch:${workspaceId}`).digest("hex").slice(0, 32);

export class OpenAiImageProvider implements ImageProvider {
  readonly id = "openai" as const;
  readonly label = "OpenAI Images";
  readonly termsUrl = OPENAI_IMAGES_TERMS_URL;
  readonly model: string;
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly p: Platform,
    opts: { fetch?: typeof fetch; model?: string } = {},
  ) {
    if (!p.cfg.OPENAI_API_KEY) throw new AppError("PROVIDER_NOT_CONFIGURED", "OPENAI_API_KEY is not set", { userMessage: "Image generation isn't connected on this deployment yet." });
    this.apiKey = p.cfg.OPENAI_API_KEY;
    this.model = opts.model ?? p.cfg.OPENAI_IMAGE_MODEL;
    this.baseUrl = p.cfg.OPENAI_BASE_URL.replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async generate(ctx: CallContext, input: ImageGenerateInput): Promise<ImageResult> {
    const body = {
      model: this.model,
      prompt: input.prompt,
      n: input.n,
      size: input.size,
      quality: "medium",
      output_format: "png",
      safety_identifier: safetyId(ctx.workspaceId),
    };
    return this.call(ctx, "image_generate", input.n, body, () =>
      this.fetchImpl(`${this.baseUrl}/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: ctx.signal,
      }),
    );
  }

  async edit(ctx: CallContext, input: ImageEditInput): Promise<ImageResult> {
    if (!input.images.length) throw new AppError("BAD_REQUEST", "Image edit needs at least one source image");
    const form = new FormData();
    form.append("model", this.model);
    form.append("prompt", input.prompt);
    form.append("n", String(input.n));
    form.append("size", input.size);
    form.append("quality", "medium");
    form.append("output_format", "png");
    form.append("safety_identifier", safetyId(ctx.workspaceId));
    for (const img of input.images) form.append("image[]", new Blob([img.data as Uint8Array<ArrayBuffer>], { type: img.mimeType }), img.filename);
    const traceBody = { model: this.model, prompt: input.prompt, n: input.n, size: input.size, quality: "medium", images: input.images.map((i) => ({ filename: i.filename, mimeType: i.mimeType, bytes: i.data.byteLength })) };
    return this.call(ctx, "image_edit", input.n, traceBody, () =>
      this.fetchImpl(`${this.baseUrl}/images/edits`, { method: "POST", headers: { authorization: `Bearer ${this.apiKey}` }, body: form, signal: ctx.signal }),
    );
  }

  private async call(ctx: CallContext, operation: "image_generate" | "image_edit", n: number, traceRequest: unknown, send: () => Promise<Response>): Promise<ImageResult> {
    const { value, usageEvent } = await meterExternal(this.p, ctx, { provider: "openai", model: this.model, operation, estimatedUsd: n * 0.12 }, async () => {
      let res: Response | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await send();
        if (res.status !== 429 && res.status !== 502 && res.status !== 503) break;
        if (attempt < 2) {
          await res.body?.cancel().catch(() => {});
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt + Math.random() * 500));
        }
      }
      if (!res!.ok) throw await httpError(res!, "OpenAI Images");
      const json = (await res!.json()) as OpenAiImagesResponse;
      const fmt = json.output_format ?? "png";
      const images: GeneratedImage[] = (json.data ?? [])
        .filter((d) => typeof d.b64_json === "string" && d.b64_json.length > 0)
        .map((d) => ({ data: Buffer.from(d.b64_json!, "base64"), mimeType: `image/${fmt}` as GeneratedImage["mimeType"], revisedPrompt: d.revised_prompt }));
      if (!images.length) throw new AppError("PROVIDER_ERROR", "OpenAI Images returned no image data");
      const cost = openAiImageCost(this.model, images.length, json.usage);
      return {
        value: images,
        usage: { images: images.length, inputTokens: json.usage?.input_tokens, outputTokens: json.usage?.output_tokens, costUsdEstimate: cost },
        trace: { request: traceRequest, response: { created: json.created, images: images.map((i) => ({ bytes: i.data.length, mimeType: i.mimeType })), usage: json.usage } },
      };
    });
    return { images: value, provider: "openai", model: this.model, usageEventId: usageEvent.id, costUsd: usageEvent.costUsdEstimate };
  }
}
