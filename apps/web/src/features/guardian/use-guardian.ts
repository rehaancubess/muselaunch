"use client";
/**
 * Owner: module G (Brand Guardian). Data hooks for `apps/api/src/routes/guardian.ts`.
 * Reviews are polled while queued/running (they finish in seconds on the local GPU).
 */
import type { BrandFinding, BrandReview, BrandReviewSubjectEntity, Claim, BrandPreference, Composition, CompositionPatch, CompositionVersion, Job } from "@muselaunch/contracts";
import { useCallback, useState } from "react";
import { ApiError, api, wsPath } from "@/lib/api";
import { useApiQuery, useInvalidate } from "@/lib/query";

export interface GuardianSubject {
  entity: BrandReviewSubjectEntity;
  id: string;
}

export interface GlimmerInfo {
  configured: boolean;
  model: string;
  label: string;
}

export type ReviewItem = BrandReview & { current: boolean };

export interface ReviewsResponse {
  items: ReviewItem[];
  nextCursor: string | null;
  current: { version?: number; contentHash: string } | null;
  glimmer: GlimmerInfo;
}

export interface CreateReviewResponse {
  review: BrandReview;
  job: Job | null;
  reused: boolean;
  glimmer: GlimmerInfo;
}

export interface ApplyFindingResponse {
  review: BrandReview;
  composition: Composition;
  version: CompositionVersion;
  patch: CompositionPatch | null;
  reReview: { review: BrandReview; job: Job | null; reused: boolean };
}

export interface DismissFindingResponse {
  review: BrandReview;
  preference: BrandPreference | null;
}

/** Short review shape the API attaches to gate errors and gated responses (`reviewBrief`). */
export interface ReviewBrief {
  id: string;
  status: BrandReview["status"];
  engine: "glimmer" | "rules";
  label?: string;
  note?: string;
  subjectVersion?: number;
  summary: string;
  latencyMs?: number;
  blocking: { id: string; category: BrandFinding["category"]; message: string; location?: BrandFinding["location"] }[];
  overridden?: boolean;
}

export const isRunning = (r: Pick<BrandReview, "status"> | null | undefined) => r?.status === "queued" || r?.status === "running";

/** Reviews of a subject (newest first) + the one for the exact version/content now. */
export function useBrandReviews(workspaceId: string, subject: GuardianSubject | null, version?: number) {
  const q = useApiQuery<ReviewsResponse>(subject ? wsPath(workspaceId, "/reviews") : null, {
    query: subject ? { subjectId: subject.id, entity: subject.entity, version } : undefined,
    staleTime: 10_000,
    refetchInterval: (query) => (query.state.data?.items.some((r) => r.current && isRunning(r)) ? 1500 : false),
  });
  const latest = q.data?.items.find((r) => r.current) ?? null;
  return { query: q, latest, glimmer: q.data?.glimmer ?? null };
}

/** Claim + memory text for evidence chips (App DNA routes). */
export function useEvidence(workspaceId: string, appId: string | null) {
  const claims = useApiQuery<{ items: Claim[] }>(appId ? wsPath(workspaceId, `/apps/${appId}/claims`) : null, { staleTime: 60_000 });
  const memory = useApiQuery<{ items: BrandPreference[] }>(appId ? wsPath(workspaceId, `/apps/${appId}/memory`) : null, { staleTime: 30_000 });
  return {
    claim: (id: string) => claims.data?.items.find((c) => c.id === id) ?? null,
    preference: (id: string) => memory.data?.items.find((m) => m.id === id) ?? null,
  };
}

/** Mutations: run / re-run, apply a fix, dismiss (remembered). */
export function useGuardianActions(workspaceId: string) {
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState<string | null>(null);
  const refresh = useCallback(() => invalidate(wsPath(workspaceId, "/reviews")), [invalidate, workspaceId]);
  const wrap = useCallback(
    async <T,>(key: string, fn: () => Promise<T>): Promise<T> => {
      setBusy(key);
      try {
        return await fn();
      } finally {
        setBusy(null);
        void refresh();
      }
    },
    [refresh],
  );
  return {
    busy,
    refresh,
    run: (subject: GuardianSubject, opts: { version?: number; rerun?: boolean } = {}) =>
      wrap("run", () => api.post<CreateReviewResponse>(wsPath(workspaceId, "/reviews"), { subject, version: opts.version, rerun: opts.rerun ?? false }, { idempotent: true })),
    apply: (reviewId: string, findingId: string) => wrap(`apply:${findingId}`, () => api.post<ApplyFindingResponse>(wsPath(workspaceId, `/reviews/${reviewId}/findings/${findingId}/apply`))),
    dismiss: (reviewId: string, findingId: string, reason: string) =>
      wrap(`dismiss:${findingId}`, () => api.post<DismissFindingResponse>(wsPath(workspaceId, `/reviews/${reviewId}/findings/${findingId}/dismiss`), { reason })),
  };
}

/** A gated action was refused because the latest review is blocked: the review to show + override. */
export function brandBlockOf(err: unknown): ReviewBrief | null {
  if (!(err instanceof ApiError) || err.code !== "APPROVAL_REQUIRED") return null;
  if (err.details?.reason !== "brand_review_blocked") return null;
  return (err.details.review as ReviewBrief | undefined) ?? null;
}

/** The gate is still reviewing (a review of this content is queued/running). */
export const isBrandReviewRunning = (err: unknown) => err instanceof ApiError && err.status === 409 && err.details?.reason === "brand_review_running";
