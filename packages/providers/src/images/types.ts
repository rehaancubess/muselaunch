import type { ModelUsageEvent } from "@muselaunch/contracts";
import type { CallContext } from "../meta/client";

export type ImageSize = "1024x1024" | "1024x1536" | "1536x1024";

export interface ImageGenerateInput {
  /** Final prompt (already passed through `guardImagePrompt`). */
  prompt: string;
  n: number;
  size: ImageSize;
  /** Stable, non-identifying end-user id for provider abuse monitoring (hashed). */
  endUser?: string;
}

export interface ImageEditInput extends ImageGenerateInput {
  /** Source image(s) to revise (PNG/JPEG/WebP bytes). */
  images: { data: Uint8Array; mimeType: string; filename: string }[];
}

export interface GeneratedImage {
  data: Buffer;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  revisedPrompt?: string;
}

export interface ImageResult {
  images: GeneratedImage[];
  provider: "openai" | "muse";
  model: string;
  usageEventId?: string;
  costUsd: number;
}

export interface ImageProvider {
  readonly id: "openai" | "muse";
  readonly label: string;
  readonly model: string;
  readonly termsUrl: string;
  generate(ctx: CallContext, input: ImageGenerateInput): Promise<ImageResult>;
  edit(ctx: CallContext, input: ImageEditInput): Promise<ImageResult>;
}

export type UsageLink = Pick<ModelUsageEvent, "id">;
