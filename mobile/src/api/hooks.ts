/** The screens' reads, through react-query (polled while something is moving). */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "../session";
import type { CalendarResponse, EstimateResponse, Job, SignedUrl, TodayResponse } from "./types";
import { isPostChangeRunning } from "./types";

export const TERMINAL: Job["status"][] = ["succeeded", "failed", "cancelled"];

export function useToday() {
  const { api, appId, workspaceId } = useSession();
  return useQuery({
    queryKey: ["today", workspaceId, appId],
    queryFn: () => api.get<TodayResponse>(api.ws(`/apps/${appId}/today`)),
    enabled: Boolean(workspaceId && appId),
    refetchInterval: (q) => (q.state.data?.posts.some((p) => isPostChangeRunning(p.change)) ? 3000 : 20_000),
  });
}

/** Posts already scheduled to go out (Coming up), the next 60 days. */
export function useCalendar(tz: string) {
  const { api, appId, workspaceId } = useSession();
  const now = Math.floor(Date.now() / 600_000) * 600_000;
  const range = { from: new Date(now - 3_600_000).toISOString(), to: new Date(now + 60 * 86_400_000).toISOString(), timezone: tz };
  return useQuery({
    queryKey: ["calendar", workspaceId, appId, range.from],
    queryFn: () => api.get<CalendarResponse>(api.ws(`/apps/${appId}/calendar`), range),
    enabled: Boolean(workspaceId && appId),
    staleTime: 15_000,
    retry: false,
  });
}

/** A short-lived signed URL for an asset (refreshed well before its hour is up). */
export function useAssetUrl(assetId: string | null | undefined, opts: { download?: boolean } = {}) {
  const { api, workspaceId } = useSession();
  return useQuery({
    queryKey: ["asset-url", workspaceId, assetId, Boolean(opts.download)],
    queryFn: async () => {
      const s = await api.get<SignedUrl>(api.ws(`/assets/${assetId}/url`), opts.download ? { download: 1 } : undefined);
      return { ...s, url: s.url.startsWith("http") ? s.url : `${api.base}${s.url}` };
    },
    enabled: Boolean(workspaceId && assetId),
    staleTime: 45 * 60_000,
    refetchInterval: 50 * 60_000,
    retry: false,
  });
}

export function useJob(jobId: string | null | undefined) {
  const { api, workspaceId } = useSession();
  return useQuery({
    queryKey: ["job", workspaceId, jobId],
    queryFn: () => api.get<{ job: Job }>(api.ws(`/jobs/${jobId}`)).then((r) => r.job),
    enabled: Boolean(workspaceId && jobId),
    refetchInterval: (q) => (q.state.data && TERMINAL.includes(q.state.data.status) ? false : 2500),
  });
}

/** The real price of an operation (POST /estimate), with the credits available. */
export function useEstimate(operation: string, params: Record<string, unknown>, enabled = true) {
  const { api, workspaceId } = useSession();
  return useQuery({
    queryKey: ["estimate", workspaceId, operation, params],
    queryFn: () => api.post<EstimateResponse>(api.ws("/estimate"), { operation, params }),
    enabled: Boolean(workspaceId) && enabled,
    staleTime: 60_000,
    retry: false,
  });
}

/** Refresh what a post change, a decision or a new run touches. */
export function useRefresh() {
  const qc = useQueryClient();
  return (...keys: string[]) => Promise.all(keys.map((k) => qc.invalidateQueries({ queryKey: [k] })));
}

/** Poll a job until it's done (imperative flows: uploads, transcription). */
export async function waitForJob(get: (jobId: string) => Promise<Job>, jobId: string, timeoutMs = 4 * 60_000): Promise<Job> {
  const deadline = Date.now() + timeoutMs;
  let delay = 600;
  for (;;) {
    const job = await get(jobId);
    if (TERMINAL.includes(job.status)) return job;
    if (Date.now() > deadline) throw new Error("This is taking longer than expected. Try again in a moment.");
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(2500, Math.round(delay * 1.4));
  }
}
