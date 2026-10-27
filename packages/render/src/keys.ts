import { shortHash } from "./media";

export const PREVIEW_SCALE = Number(process.env.RENDER_PREVIEW_SCALE ?? 0.5);

/** Render cache key: same doc + quality + format ⇒ same output asset id (`ast_r_<key>`). */
export function renderCacheKey(hash: string, quality: "preview" | "final", format: string): string {
  return shortHash(`${hash}:${quality}:${format}:${quality === "preview" ? PREVIEW_SCALE : 1}`, 24);
}

export const renderAssetId = (hash: string, quality: "preview" | "final", format: string) => `ast_r_${renderCacheKey(hash, quality, format)}`;
