import { EventEmitter } from "node:events";
import { Invite, UserProfile, Workspace, type CreateInput, type EntityName, type EntityOf } from "@muselaunch/contracts";
import type { z } from "zod";
import { assertIndexed } from "./indexes";
import {
  DbError,
  type Db,
  type ListQuery,
  type Page,
  type Repo,
  type StateDoc,
  type TopLevelName,
  type TopLevelOf,
  type TopLevelRepo,
  type Tx,
  type UpdateOpts,
  type Where,
  type WorkspaceDb,
  type WriteOpts,
} from "./types";
import {
  assertCollection,
  assertWorkspaceId,
  buildEntity,
  decodeCursor,
  encodeCursor,
  getPath,
  mergeEntity,
  newEntityId,
  nowIso,
  readEntity,
  stripUndefined,
} from "./util";

const TOP_SCHEMAS = { users: UserProfile, workspaces: Workspace, invites: Invite } as const;

type Doc = Record<string, unknown>;

class Mutex {
  private tail: Promise<void> = Promise.resolve();
  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = this.tail;
    this.tail = prev.then(() => next);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface MemoryDbOptions {
  /** Enforce declared Firestore composite indexes (default true). */
  strictIndexes?: boolean;
}

/**
 * In-process implementation of the repository contract. Used by tests and by
 * `DB_DRIVER=memory` local runs. Semantics mirror Firestore closely enough to catch
 * tenancy, index and transaction mistakes before they reach production.
 */
export class MemoryDb implements Db {
  readonly driver = "memory" as const;
  private readonly collections = new Map<string, Map<string, Doc>>();
  private readonly events = new EventEmitter();
  private readonly mutex = new Mutex();
  readonly strictIndexes: boolean;

  constructor(opts: MemoryDbOptions = {}) {
    this.strictIndexes = opts.strictIndexes ?? true;
    this.events.setMaxListeners(1000);
  }

  // ---- low-level storage -------------------------------------------------
  private coll(path: string): Map<string, Doc> {
    let c = this.collections.get(path);
    if (!c) {
      c = new Map();
      this.collections.set(path, c);
    }
    return c;
  }
  readRaw(collPath: string, id: string): Doc | null {
    const d = this.collections.get(collPath)?.get(id);
    return d ? structuredClone(d) : null;
  }
  writeRaw(collPath: string, id: string, doc: Doc | null): void {
    if (doc === null) this.coll(collPath).delete(id);
    else this.coll(collPath).set(id, structuredClone(stripUndefined(doc)));
    this.events.emit(`${collPath}/${id}`, doc ? structuredClone(doc) : null);
  }
  listRaw(collPath: string): Doc[] {
    return [...(this.collections.get(collPath)?.values() ?? [])].map((d) => structuredClone(d));
  }
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.mutex.run(fn);
  }
  on(path: string, cb: (doc: Doc | null) => void): () => void {
    this.events.on(path, cb);
    return () => this.events.off(path, cb);
  }

  // ---- public API ----------------------------------------------------------
  ws(workspaceId: string): WorkspaceDb {
    assertWorkspaceId(workspaceId);
    return {
      workspaceId,
      collection: <N extends EntityName>(name: N) => new MemoryRepo<N>(this, workspaceId, name),
      state: <S extends z.ZodTypeAny>(key: string, schema: S) => this.stateDoc(`workspaces/${workspaceId}/state`, key, schema),
    };
  }

  top<N extends TopLevelName>(name: N): TopLevelRepo<N> {
    const schema = TOP_SCHEMAS[name] as unknown as z.ZodTypeAny;
    const path = name;
    return {
      get: async (id) => {
        const raw = this.readRaw(path, id);
        return raw ? (schema.parse(raw) as TopLevelOf<N>) : null;
      },
      set: async (id, value) => {
        const v = schema.parse(value);
        await this.withLock(async () => this.writeRaw(path, id, v as Doc));
      },
      update: async (id, patch) =>
        this.withLock(async () => {
          const raw = this.readRaw(path, id);
          if (!raw) throw new DbError("NOT_FOUND", `${name}/${id} not found`);
          const v = schema.parse({ ...raw, ...stripUndefined(patch as Doc), updatedAt: nowIso() }) as TopLevelOf<N>;
          this.writeRaw(path, id, v as Doc);
          return v;
        }),
      delete: async (id) => this.withLock(async () => this.writeRaw(path, id, null)),
      list: async (q) => queryDocs(this.listRaw(path), q ?? {}) as Page<TopLevelOf<N>>,
    };
  }

  global<S extends z.ZodTypeAny>(key: string, schema: S): StateDoc<z.infer<S>> {
    return this.stateDoc("ops", key, schema);
  }

  private stateDoc<S extends z.ZodTypeAny>(path: string, key: string, schema: S): StateDoc<z.infer<S>> {
    return {
      get: async () => {
        const raw = this.readRaw(path, key);
        return raw ? (schema.parse(raw) as z.infer<S>) : null;
      },
      set: async (value) => {
        const v = schema.parse(value);
        await this.withLock(async () => this.writeRaw(path, key, v as Doc));
      },
    };
  }

  async runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      const tx = new MemoryTx(this);
      const result = await fn(tx);
      tx.commit();
      return result;
    });
  }

  async close(): Promise<void> {
    this.events.removeAllListeners();
  }

  /** Test helper: drop everything. */
  reset(): void {
    this.collections.clear();
  }
}

class MemoryRepo<N extends EntityName> implements Repo<N> {
  private readonly path: string;
  constructor(
    private readonly db: MemoryDb,
    readonly workspaceId: string,
    readonly name: N,
  ) {
    assertCollection(name);
    this.path = `workspaces/${workspaceId}/${name}`;
  }

  newId(): string {
    return newEntityId(this.name);
  }

  async get(id: string): Promise<EntityOf<N> | null> {
    const raw = this.db.readRaw(this.path, id);
    return raw ? readEntity(this.name, raw) : null;
  }

  async getOrThrow(id: string): Promise<EntityOf<N>> {
    const d = await this.get(id);
    if (!d) throw new DbError("NOT_FOUND", `${this.name}/${id} not found`);
    return d;
  }

  async getMany(ids: readonly string[]): Promise<EntityOf<N>[]> {
    const out: EntityOf<N>[] = [];
    for (const id of ids) {
      const d = await this.get(id);
      if (d) out.push(d);
    }
    return out;
  }

  async create(input: CreateInput<N>, opts: WriteOpts): Promise<EntityOf<N>> {
    const entity = buildEntity(this.name, this.workspaceId, input as Doc, opts.actor);
    const id = (entity as { id: string }).id;
    return this.db.withLock(async () => {
      if (this.db.readRaw(this.path, id)) throw new DbError("ALREADY_EXISTS", `${this.name}/${id} already exists`);
      this.db.writeRaw(this.path, id, entity as Doc);
      return entity;
    });
  }

  async createIfAbsent(input: CreateInput<N> & { id: string }, opts: WriteOpts): Promise<{ entity: EntityOf<N>; created: boolean }> {
    const entity = buildEntity(this.name, this.workspaceId, input as Doc, opts.actor);
    return this.db.withLock(async () => {
      const existing = this.db.readRaw(this.path, input.id);
      if (existing) return { entity: readEntity(this.name, existing), created: false };
      this.db.writeRaw(this.path, input.id, entity as Doc);
      return { entity, created: true };
    });
  }

  async update(id: string, patch: Partial<EntityOf<N>>, opts: UpdateOpts): Promise<EntityOf<N>> {
    return this.db.withLock(async () => {
      const raw = this.db.readRaw(this.path, id);
      if (!raw) throw new DbError("NOT_FOUND", `${this.name}/${id} not found`);
      if (opts.expectedUpdatedAt && raw.updatedAt !== opts.expectedUpdatedAt) {
        throw new DbError("CONFLICT", `${this.name}/${id} was modified concurrently`);
      }
      const merged = mergeEntity(this.name, readEntity(this.name, raw), patch as Doc);
      this.db.writeRaw(this.path, id, merged as Doc);
      return merged;
    });
  }

  async delete(id: string): Promise<void> {
    await this.db.withLock(async () => this.db.writeRaw(this.path, id, null));
  }

  async list(query: ListQuery = {}): Promise<Page<EntityOf<N>>> {
    if (this.db.strictIndexes) assertIndexed(this.name, query);
    const page = queryDocs(this.db.listRaw(this.path), query);
    return { items: page.items.map((d) => readEntity(this.name, d)), nextCursor: page.nextCursor };
  }

  async findOne(where: readonly Where[]): Promise<EntityOf<N> | null> {
    const page = await this.list({ where, limit: 1 });
    return page.items[0] ?? null;
  }

  watch(id: string, cb: (doc: EntityOf<N> | null) => void): () => void {
    queueMicrotask(async () => cb(await this.get(id)));
    return this.db.on(`${this.path}/${id}`, (doc) => cb(doc ? readEntity(this.name, doc) : null));
  }
}

class MemoryTx implements Tx {
  private readonly writes: { path: string; id: string; doc: Doc | null; mustNotExist?: boolean }[] = [];
  private readonly reads = new Map<string, Doc | null>();
  constructor(private readonly db: MemoryDb) {}

  private read(path: string, id: string): Doc | null {
    if (this.writes.length > 0) throw new DbError("TX_READ_REQUIRED", "Transaction reads must happen before writes");
    const d = this.db.readRaw(path, id);
    this.reads.set(`${path}/${id}`, d);
    return d;
  }

  async get<N extends EntityName>(workspaceId: string, name: N, id: string): Promise<EntityOf<N> | null> {
    assertCollection(name);
    const raw = this.read(`workspaces/${workspaceId}/${name}`, id);
    return raw ? readEntity(name, raw) : null;
  }
  async getState<S extends z.ZodTypeAny>(workspaceId: string, key: string, schema: S): Promise<z.infer<S> | null> {
    const raw = this.read(`workspaces/${workspaceId}/state`, key);
    return raw ? schema.parse(raw) : null;
  }
  async getGlobal<S extends z.ZodTypeAny>(key: string, schema: S): Promise<z.infer<S> | null> {
    const raw = this.read("ops", key);
    return raw ? schema.parse(raw) : null;
  }
  async getTop<N extends TopLevelName>(name: N, id: string): Promise<TopLevelOf<N> | null> {
    const raw = this.read(name, id);
    return raw ? ((TOP_SCHEMAS[name] as unknown as z.ZodTypeAny).parse(raw) as TopLevelOf<N>) : null;
  }
  create<N extends EntityName>(workspaceId: string, name: N, input: CreateInput<N>, opts: WriteOpts): EntityOf<N> {
    assertCollection(name);
    const entity = buildEntity(name, workspaceId, input as Doc, opts.actor);
    this.writes.push({ path: `workspaces/${workspaceId}/${name}`, id: (entity as { id: string }).id, doc: entity as Doc, mustNotExist: true });
    return entity;
  }
  update<N extends EntityName>(workspaceId: string, name: N, id: string, patch: Partial<EntityOf<N>>, _opts: WriteOpts): EntityOf<N> {
    const path = `workspaces/${workspaceId}/${name}`;
    const key = `${path}/${id}`;
    if (!this.reads.has(key)) throw new DbError("TX_READ_REQUIRED", `Read ${name}/${id} in the transaction before updating it`);
    const prior = this.pendingOrRead(path, id);
    if (!prior) throw new DbError("NOT_FOUND", `${name}/${id} not found`);
    const merged = mergeEntity(name, readEntity(name, prior), patch as Doc);
    this.writes.push({ path, id, doc: merged as Doc });
    return merged;
  }
  delete(workspaceId: string, name: EntityName, id: string): void {
    this.writes.push({ path: `workspaces/${workspaceId}/${name}`, id, doc: null });
  }
  setState<S extends z.ZodTypeAny>(workspaceId: string, key: string, schema: S, value: z.infer<S>): void {
    this.writes.push({ path: `workspaces/${workspaceId}/state`, id: key, doc: schema.parse(value) as Doc });
  }
  setGlobal<S extends z.ZodTypeAny>(key: string, schema: S, value: z.infer<S>): void {
    this.writes.push({ path: "ops", id: key, doc: schema.parse(value) as Doc });
  }
  setTop<N extends TopLevelName>(name: N, id: string, value: TopLevelOf<N>): void {
    this.writes.push({ path: name, id, doc: (TOP_SCHEMAS[name] as unknown as z.ZodTypeAny).parse(value) as Doc });
  }

  private pendingOrRead(path: string, id: string): Doc | null {
    for (let i = this.writes.length - 1; i >= 0; i--) {
      const w = this.writes[i]!;
      if (w.path === path && w.id === id) return w.doc;
    }
    return this.reads.get(`${path}/${id}`) ?? null;
  }

  commit(): void {
    for (const w of this.writes) {
      if (w.mustNotExist && this.db.readRaw(w.path, w.id)) throw new DbError("ALREADY_EXISTS", `${w.path}/${w.id} already exists`);
    }
    for (const w of this.writes) this.db.writeRaw(w.path, w.id, w.doc);
  }
}

// ---- query evaluation --------------------------------------------------------

function matches(doc: Doc, [field, op, value]: Where): boolean {
  const v = getPath(doc, field);
  switch (op) {
    case "==":
      return v === value;
    case "!=":
      return v !== undefined && v !== value;
    case "<":
      return v !== undefined && (v as number) < (value as number);
    case "<=":
      return v !== undefined && (v as number) <= (value as number);
    case ">":
      return v !== undefined && (v as number) > (value as number);
    case ">=":
      return v !== undefined && (v as number) >= (value as number);
    case "in":
      return (value as unknown[]).includes(v);
    case "not-in":
      return v !== undefined && !(value as unknown[]).includes(v);
    case "array-contains":
      return Array.isArray(v) && v.includes(value);
    case "array-contains-any":
      return Array.isArray(v) && (value as unknown[]).some((x) => v.includes(x));
  }
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  return (a as number) < (b as number) ? -1 : 1;
}

export function queryDocs(all: Doc[], q: ListQuery): Page<Doc> {
  let docs = all.filter((d) => (q.where ?? []).every((w) => matches(d, w)));
  const order = q.orderBy;
  docs.sort((a, b) => {
    if (order) {
      const c = compare(getPath(a, order.field), getPath(b, order.field));
      if (c !== 0) return order.dir === "desc" ? -c : c;
    }
    const ci = compare(a.id, b.id);
    return order?.dir === "desc" ? -ci : ci;
  });
  // Firestore excludes docs missing the orderBy field.
  if (order) docs = docs.filter((d) => getPath(d, order.field) !== undefined);
  if (q.cursor) {
    const lastId = decodeCursor(q.cursor);
    const idx = docs.findIndex((d) => d.id === lastId);
    docs = idx >= 0 ? docs.slice(idx + 1) : docs;
  }
  const limit = q.limit ?? 50;
  const items = docs.slice(0, limit);
  const nextCursor = docs.length > limit && items.length ? encodeCursor(String(items[items.length - 1]!.id)) : null;
  return { items, nextCursor };
}
