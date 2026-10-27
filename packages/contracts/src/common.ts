import { z } from "zod";

/** Opaque identifier: `<prefix>_<time-sortable random>`; Firestore-safe characters only. */
export const Id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/, "invalid id");
export type Id = z.infer<typeof Id>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

export const HttpUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048);

export const HexColor = z.string().regex(/^#(?:[0-9a-fA-F]{3}){1,2}(?:[0-9a-fA-F]{2})?$/);

export const Percent01 = z.number().min(0).max(1);

/** Actor string: a user uid, `agent:<runId>`, or `system`. */
export const Actor = z.string().min(1).max(160);
export type Actor = z.infer<typeof Actor>;

/** Fields every workspace-scoped entity carries. */
export const BaseEntity = z.object({
  id: Id,
  workspaceId: Id,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  createdBy: Actor,
});
export type BaseEntity = z.infer<typeof BaseEntity>;

/** Fields the repository sets; omitted from create inputs. */
export const SYSTEM_FIELDS = ["id", "workspaceId", "createdAt", "updatedAt", "createdBy"] as const;

export const ReviewState = z.enum(["verified", "needs_review", "rejected"]);
export type ReviewState = z.infer<typeof ReviewState>;

export const Platform = z.enum(["ios", "android", "web", "macos", "windows", "linux", "other"]);
export type Platform = z.infer<typeof Platform>;

/** Distribution channels / social networks. */
export const Channel = z.enum([
  "instagram",
  "facebook",
  "tiktok",
  "youtube",
  "linkedin",
  "x",
  "threads",
  "reddit",
  "producthunt",
  "hackernews",
  "newsletter",
  "website",
  "app_store",
  "google_play",
  "other",
]);
export type Channel = z.infer<typeof Channel>;

export const AspectRatio = z.enum(["9:16", "1:1", "16:9", "4:5"]);
export type AspectRatio = z.infer<typeof AspectRatio>;

export const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "16:9": { width: 1920, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

/**
 * Provenance for any fact. Research findings and claims must carry at least one.
 * `model_inference` is allowed only for interpretations, never as sole evidence of an external fact.
 */
export const SourceKind = z.enum([
  "url",
  "store_listing",
  "upload",
  "screenshot",
  "recording",
  "document",
  "user_input",
  "api",
  "search_result",
  "model_inference",
]);
export type SourceKind = z.infer<typeof SourceKind>;

export const SourceRef = z.object({
  kind: SourceKind,
  url: HttpUrl.optional(),
  title: z.string().max(500).optional(),
  publisher: z.string().max(200).optional(),
  assetId: Id.optional(),
  evidenceId: Id.optional(),
  retrievedAt: IsoDateTime,
  publishedAt: IsoDateTime.optional(),
  excerpt: z.string().max(2000).optional(),
  contentHash: z.string().max(128).optional(),
});
export type SourceRef = z.infer<typeof SourceRef>;

/** Reference to another entity by collection + id. */
export const EntityRef = z.object({ entity: z.string().min(1).max(64), id: Id });
export type EntityRef = z.infer<typeof EntityRef>;

export const Money = z.object({ amount: z.number(), currency: z.string().length(3) });
export type Money = z.infer<typeof Money>;

export const Locale = z.string().min(2).max(16);

/** User-visible error contract shared by API responses, jobs and agent runs. */
export const ErrorInfo = z.object({
  code: z.string().min(1).max(80),
  message: z.string().max(4000),
  /** Safe, non-technical text the UI can show. */
  userMessage: z.string().max(500).optional(),
  retryable: z.boolean().default(false),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ErrorInfo = z.infer<typeof ErrorInfo>;

export const Pagination = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type Pagination = z.infer<typeof Pagination>;

export function page<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}
