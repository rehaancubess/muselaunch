"use client";
import { CostEstimate, type EstimateResult } from "@muselaunch/ui";
import type { ReactNode } from "react";
import { api, wsPath } from "./api";
import type { EstimateResponse } from "./api-types";
import { useWorkspace } from "./workspace";

/** `POST /v1/workspaces/:wid/estimate` → credits vs available balance. */
export function fetchEstimate(workspaceId: string, req: { operation: string; params: Record<string, unknown> }): Promise<EstimateResult> {
  return api.post<EstimateResponse>(wsPath(workspaceId, "/estimate"), req);
}

/**
 * Cost estimate bound to the current workspace. Show before any costly action
 * (analysis, research, concepts, renders, segmentation, image generation).
 */
export function WorkspaceCostEstimate({ operation, params, onEstimate, className, note }: { operation: string; params?: Record<string, unknown>; onEstimate?: (e: EstimateResult | null) => void; className?: string; note?: ReactNode }) {
  const { workspaceId } = useWorkspace();
  return <CostEstimate operation={operation} params={params} fetchEstimate={(req) => fetchEstimate(workspaceId, req)} onEstimate={onEstimate} className={className} note={note} />;
}
