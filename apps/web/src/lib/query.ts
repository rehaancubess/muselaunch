"use client";
import { QueryClient, useMutation, useQuery, useQueryClient, type QueryKey, type UseQueryOptions } from "@tanstack/react-query";
import { ApiError, api, type Query } from "./api";

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => {
          if (err instanceof ApiError && !err.retryable) return false;
          return count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

/** Query key for an API path (+ query string). Use the same path to invalidate. */
export const keyFor = (path: string, query?: Query): QueryKey => (query ? [path, query] : [path]);

/**
 * GET an API path with caching. Pass `null` to disable (e.g. missing ids).
 * Errors are `ApiError` with a user-safe `userMessage`.
 */
export function useApiQuery<T>(path: string | null, opts: { query?: Query } & Omit<UseQueryOptions<T, ApiError, T, QueryKey>, "queryKey" | "queryFn"> = {}) {
  const { query, ...rest } = opts;
  return useQuery<T, ApiError, T, QueryKey>({
    queryKey: path ? keyFor(path, query) : ["__disabled__"],
    queryFn: ({ signal }) => api.get<T>(path as string, { query, signal }),
    enabled: Boolean(path) && (rest.enabled ?? true),
    ...rest,
  });
}

/** Invalidate every cached query whose path starts with `prefix`. */
export function useInvalidate() {
  const qc = useQueryClient();
  return (...prefixes: string[]) =>
    Promise.all(
      prefixes.map((prefix) =>
        qc.invalidateQueries({ predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith(prefix) }),
      ),
    );
}

export { useMutation, useQueryClient };
