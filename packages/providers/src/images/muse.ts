import { AppError, museImageEligible, type Platform } from "@muselaunch/platform";
import { metaClient, type CallContext } from "../meta/client";
import { PRICES } from "../pricing";
import type { GeneratedImage, ImageEditInput, ImageGenerateInput, ImageProvider, ImageResult } from "./types";

/**
 * Muse Image (`muse-image-1.0`, https://dev.meta.ai/docs/image-generation): `POST /v1/images/generations`
 * (JSON) and `POST /v1/images/edits` (JSON `images: [{ image_url }]`; `mask` unsupported).
 *
 * GEO GATE: Meta's Geographic Use Policy restricts Muse Image in some countries (incl. India, where
 * this deployment's operator is). This adapter can only be constructed — and every call re-checks —
 * when `museImageEligible(cfg, endUserCountry)` passes. It never falls back silently: an ineligible
 * call throws PROVIDER_RESTRICTED; callers choose the licensed alternative explicitly.
 */
export class MuseImageProvider implements ImageProvider {
  readonly id = "muse" as const;
  readonly label = "Muse Image (Meta)";
  readonly termsUrl = "https://dev.meta.ai/docs/image-generation";
  readonly model: string;

  private constructor(
    private readonly p: Platform,
    private readonly endUserCountry: string,
  ) {
    this.model = p.cfg.META_MODEL_IMAGE;
  }

  /** Returns a provider only when the eligibility gate passes; otherwise throws PROVIDER_RESTRICTED. */
  static create(p: Platform, endUserCountry: string | undefined): MuseImageProvider {
    const gate = museImageEligible(p.cfg, endUserCountry);
    if (!gate.eligible || !endUserCountry) throw new AppError("PROVIDER_RESTRICTED", `Muse Image unavailable: ${gate.reason}`, { details: { reason: gate.reason } });
    return new MuseImageProvider(p, endUserCountry);
  }

  private assertEligible() {
    const gate = museImageEligible(this.p.cfg, this.endUserCountry);
    if (!gate.eligible) throw new AppError("PROVIDER_RESTRICTED", `Muse Image unavailable: ${gate.reason}`, { details: { reason: gate.reason } });
  }

  async generate(ctx: CallContext, input: ImageGenerateInput): Promise<ImageResult> {
    this.assertEligible();
    const body = { model: this.model, prompt: input.prompt, n: input.n, size: input.size, response_format: "b64_json", output_format: "png" };
    return this.call(ctx, "image_generate", input.n, "/images/generations", body);
  }

  async edit(ctx: CallContext, input: ImageEditInput): Promise<ImageResult> {
    this.assertEligible();
    if (!input.images.length || input.images.length > 10) throw new AppError("BAD_REQUEST", "Muse Image edits take 1–10 images");
    // Only documented edit fields: unknown top-level fields are rejected with 400.
    const body = {
      model: this.model,
      prompt: input.prompt,
      n: input.n,
      images: input.images.map((i) => ({ image_url: `data:${i.mimeType};base64,${Buffer.from(i.data).toString("base64")}` })),
    };
    return this.call(ctx, "image_edit", input.n, "/images/edits", body);
  }

  private async call(ctx: CallContext, operation: "image_generate" | "image_edit", n: number, path: string, body: Record<string, unknown>): Promise<ImageResult> {
    const client = metaClient(this.p);
    client.requireMeta("Muse Image");
    let costUsd = 0;
    const images = await client.metered(ctx, { model: this.model, operation, estimatedUsd: n * PRICES.museImagePerImage }, async () => {
      const { data } = await client.fetchJson<{ data?: { b64_json?: string }[]; output_format?: string }>(path, { body, signal: ctx.signal });
      const fmt = data.output_format === "jpeg" || data.output_format === "webp" ? data.output_format : data.output_format === "png" ? "png" : "webp";
      const out: GeneratedImage[] = (data.data ?? []).filter((d) => d.b64_json).map((d) => ({ data: Buffer.from(d.b64_json!, "base64"), mimeType: `image/${fmt}` as GeneratedImage["mimeType"] }));
      if (!out.length) throw new AppError("PROVIDER_ERROR", "Muse Image returned no image data");
      costUsd = out.length * PRICES.museImagePerImage;
      return {
        value: out,
        usage: { provider: "meta", model: this.model, operation, images: out.length, costUsdEstimate: costUsd, dataMode: "standard" },
        trace: { request: body, response: { images: out.map((i) => ({ bytes: i.data.length, mimeType: i.mimeType })) } },
      };
    });
    return { images, provider: "muse", model: this.model, costUsd };
  }
}
