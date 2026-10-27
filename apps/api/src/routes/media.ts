import { Hono } from "hono";
import type { AppEnv } from "../context";

/**
 * Owner: module D (Multimodal media): segmentations, transcripts, image generation, stock, TTS.
 * Mounted under /v1/workspaces/:workspaceId (workspace scope + membership already enforced).
 * Use requireCap(...) for writes, body(c, Schema) for input, and return contract-shaped JSON.
 */
export const mediaRoutes = new Hono<AppEnv>();
