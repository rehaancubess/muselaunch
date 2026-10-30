/**
 * Allowlisted block components (BlockLayer.blockId). Each block is rendered by our own
 * compiler code from validated params; nothing in a document is ever executed.
 */
import { z } from "zod";

const Color = z.string().regex(/^(#(?:[0-9a-fA-F]{3}){1,2}(?:[0-9a-fA-F]{2})?|theme\.(background|surface|text|textMuted|accent|accent2))$/);

export const BLOCK_PARAMS = {
  /** Animated tap ring for UI demos (position is the layer box centre). */
  "tap-indicator": z.object({ color: Color.optional(), atSec: z.number().min(0).max(60).optional() }).strict(),
  /**
   * Text-only store availability pills (no third-party logos). `full`: "Download on the App Store" /
   * "Get it on Google Play" wording; `stack`: one pill per row.
   */
  "store-badges": z.object({ ios: z.boolean().optional(), android: z.boolean().optional(), web: z.boolean().optional(), label: z.string().max(60).optional(), full: z.boolean().optional(), stack: z.boolean().optional() }).strict(),
  /** Thin progress bar across the box width, filled over the layer's lifetime. */
  "progress-bar": z.object({ color: Color.optional() }).strict(),
  /** Small rounded label with a dot, used for callouts. */
  "callout-chip": z.object({ text: z.string().min(1).max(80), color: Color.optional() }).strict(),
} as const;

export type BlockId = keyof typeof BLOCK_PARAMS;
export const BLOCK_IDS = Object.keys(BLOCK_PARAMS) as BlockId[];

export function isBlockId(id: string): id is BlockId {
  return Object.prototype.hasOwnProperty.call(BLOCK_PARAMS, id);
}
