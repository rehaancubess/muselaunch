import { museImageEligible, type Platform } from "@muselaunch/platform";
import { AppError } from "@muselaunch/platform";
import { MuseImageProvider } from "./muse";
import { OpenAiImageProvider } from "./openai";
import type { ImageProvider } from "./types";

export * from "./types";
export * from "./guard";
export * from "./meter";
export { OpenAiImageProvider, openAiImageCost, OPENAI_IMAGES_TERMS_URL } from "./openai";
export { MuseImageProvider } from "./muse";

export interface ImageProviderChoice {
  id: "openai" | "muse";
  label: string;
  model: string;
  museImage: { eligible: boolean; reason: string };
}

/**
 * Decide which image provider serves a request, without constructing it (API responses name it).
 * Muse Image only when the deployment asks for it AND the geo gate passes; otherwise the licensed
 * alternative (OpenAI). Never circumvents geo controls.
 */
export function chooseImageProvider(p: Platform, endUserCountry: string | undefined): ImageProviderChoice {
  const gate = museImageEligible(p.cfg, endUserCountry);
  if (p.cfg.IMAGE_PROVIDER === "none") throw new AppError("PROVIDER_NOT_CONFIGURED", "Image generation is disabled on this deployment", { userMessage: "Image generation is turned off on this deployment." });
  if (p.cfg.IMAGE_PROVIDER === "muse" && gate.eligible && p.cfg.META_API_KEY) {
    return { id: "muse", label: "Muse Image (Meta)", model: p.cfg.META_MODEL_IMAGE, museImage: gate };
  }
  if (!p.cfg.OPENAI_API_KEY) {
    throw new AppError("PROVIDER_NOT_CONFIGURED", "No image provider configured (OPENAI_API_KEY missing; Muse Image unavailable)", {
      userMessage: "Image generation isn't connected on this deployment yet. Upload your own images or use stock.",
      details: { museImage: gate },
    });
  }
  return { id: "openai", label: "OpenAI Images", model: p.cfg.OPENAI_IMAGE_MODEL, museImage: gate };
}

/** Construct the chosen provider (tests inject `fetch` for OpenAI; Meta uses the installed MetaClient). */
export function resolveImageProvider(p: Platform, endUserCountry: string | undefined, opts: { fetch?: typeof fetch } = {}): { provider: ImageProvider; choice: ImageProviderChoice } {
  const choice = chooseImageProvider(p, endUserCountry);
  const provider = choice.id === "muse" ? MuseImageProvider.create(p, endUserCountry) : new OpenAiImageProvider(p, { fetch: opts.fetch });
  return { provider, choice };
}
