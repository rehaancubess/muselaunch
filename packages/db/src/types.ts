import type { CreateInput, EntityName, EntityOf, Invite, UserProfile, Workspace } from "@muselaunch/contracts";
import type { z } from "zod";

export type WhereOp = "==" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "not-in" | "array-contains" | "array-contains-any";
export type Where = readonly [field: string, op: WhereOp, value: unknown];

export interface ListQuery {
  where?: readonly Where[];
  orderBy?: { field: string; dir?: "asc" | "desc" };
  limit?: number;
  /** Opaque cursor from a previous page (the last document id). */
  cursor?: string | null;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface WriteOpts {
  /** uid, `agent:<runId>`, or `system`. */
  actor: string;
}

export interface UpdateOpts extends WriteOpts {
  /** Optimistic concurrency: fail with CONFLICT if the stored `updatedAt` differs. */
  expectedUpdatedAt?: string;
}

/** Typed repository for one workspace-scoped collection. */
export interface Repo<N extends EntityName> {
  readonly name: N;
  readonly workspaceId: string;
  newId(): string;
  get(id: string): Promise<EntityOf<N> | null>;
  getOrThrow(id: string): Promise<EntityOf<N>>;
  getMany(ids: readonly string[]): Promise<EntityOf<N>[]>;
  /** Fails with ALREADY_EXISTS if the id is taken. */
  create(input: CreateInput<N>, opts: WriteOpts): Promise<EntityOf<N>>;
  /** Create if absent, otherwise return the existing doc unchanged (idempotent create). */
  createIfAbsent(input: CreateInput<N> & { id: string }, opts: WriteOpts): Promise<{ entity: EntityOf<N>; created: boolean }>;
  /** Shallow-merge patch into the stored doc; result is re-validated. */
  update(id: string, patch: Partial<EntityOf<N>>, opts: UpdateOpts): Promise<EntityOf<N>>;
  delete(id: string): Promise<void>;
  list(query?: ListQuery): Promise<Page<EntityOf<N>>>;
  findOne(where: readonly Where[]): Promise<EntityOf<N> | null>;
  /** Listen for changes to a single doc (used for job progress SSE). Returns an unsubscribe fn. */
  watch(id: string, cb: (doc: EntityOf<N> | null) => void): () => void;
}

/** Keyed singleton state under `workspaces/{wid}/state/{key}` (e.g. the credit balance). */
export interface StateDoc<T> {
  get(): Promise<T | null>;
  set(value: T): Promise<void>;
}

export interface WorkspaceDb {
  readonly workspaceId: string;
  collection<N extends EntityName>(name: N): Repo<N>;
  state<S extends z.ZodTypeAny>(key: string, schema: S): StateDoc<z.infer<S>>;
}

export type TopLevelName = "users" | "workspaces" | "invites";
export type TopLevelOf<N extends TopLevelName> = N extends "users" ? UserProfile : N extends "workspaces" ? Workspace : Invite;

export interface TopLevelRepo<N extends TopLevelName> {
  get(id: string): Promise<TopLevelOf<N> | null>;
  set(id: string, value: TopLevelOf<N>): Promise<void>;
  update(id: string, patch: Partial<TopLevelOf<N>>): Promise<TopLevelOf<N>>;
  delete(id: string): Promise<void>;
  list(query?: ListQuery): Promise<Page<TopLevelOf<N>>>;
}

/**
 * Transaction handle. Firestore semantics: all reads must happen before writes;
 * `update` requires that the doc was read earlier in the same transaction.
 */
export interface Tx {
  get<N extends EntityName>(workspaceId: string, name: N, id: string): Promise<EntityOf<N> | null>;
  getState<S extends z.ZodTypeAny>(workspaceId: string, key: string, schema: S): Promise<z.infer<S> | null>;
  getGlobal<S extends z.ZodTypeAny>(key: string, schema: S): Promise<z.infer<S> | null>;
  getTop<N extends TopLevelName>(name: N, id: string): Promise<TopLevelOf<N> | null>;
  create<N extends EntityName>(workspaceId: string, name: N, input: CreateInput<N>, opts: WriteOpts): EntityOf<N>;
  update<N extends EntityName>(workspaceId: string, name: N, id: string, patch: Partial<EntityOf<N>>, opts: WriteOpts): EntityOf<N>;
  delete(workspaceId: string, name: EntityName, id: string): void;
  setState<S extends z.ZodTypeAny>(workspaceId: string, key: string, schema: S, value: z.infer<S>): void;
  setGlobal<S extends z.ZodTypeAny>(key: string, schema: S, value: z.infer<S>): void;
  setTop<N extends TopLevelName>(name: N, id: string, value: TopLevelOf<N>): void;
}

export interface Db {
  readonly driver: "memory" | "firestore";
  ws(workspaceId: string): WorkspaceDb;
  top<N extends TopLevelName>(name: N): TopLevelRepo<N>;
  /** Global singleton docs under `ops/{key}` (spend ceilings, rate counters). */
  global<S extends z.ZodTypeAny>(key: string, schema: S): StateDoc<z.infer<S>>;
  runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export class DbError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "ALREADY_EXISTS" | "CONFLICT" | "INVALID" | "TX_READ_REQUIRED" | "MISSING_INDEX" | "FORBIDDEN_COLLECTION",
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DbError";
  }
}
