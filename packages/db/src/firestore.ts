import { Invite, UserProfile, Workspace, type CreateInput, type EntityName, type EntityOf } from "@muselaunch/contracts";
import { applicationDefault, getApps, initializeApp, type App as FirebaseApp } from "firebase-admin/app";
import { FieldPath, getFirestore, type DocumentReference, type Firestore, type Query, type Transaction } from "firebase-admin/firestore";
import type { z } from "zod";
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
  mergeEntity,
  newEntityId,
  nowIso,
  readEntity,
  stripUndefined,
} from "./util";

const TOP_SCHEMAS = { users: UserProfile, workspaces: Workspace, invites: Invite } as const;
type Doc = Record<string, unknown>;

export interface FirestoreDbOptions {
  projectId?: string;
  /** Firestore database id (default "(default)"). */
  databaseId?: string;
  app?: FirebaseApp;
}

export function getFirebaseApp(projectId?: string): FirebaseApp {
  const existing = getApps()[0];
  if (existing) return existing;
  return initializeApp({ credential: applicationDefault(), projectId });
}

function isGrpcCode(err: unknown, code: number): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;
}

/** Production driver over the Firebase Admin SDK (server-only; client rules deny all access). */
export class FirestoreDb implements Db {
  readonly driver = "firestore" as const;
  readonly fs: Firestore;

  constructor(opts: FirestoreDbOptions = {}) {
    const app = opts.app ?? getFirebaseApp(opts.projectId);
    this.fs = opts.databaseId ? getFirestore(app, opts.databaseId) : getFirestore(app);
    try {
      this.fs.settings({ ignoreUndefinedProperties: true });
    } catch {
      // settings() can only be called once per instance; ignore on hot reload.
    }
  }

  ws(workspaceId: string): WorkspaceDb {
    assertWorkspaceId(workspaceId);
    return {
      workspaceId,
      collection: <N extends EntityName>(name: N) => new FirestoreRepo<N>(this.fs, workspaceId, name),
      state: <S extends z.ZodTypeAny>(key: string, schema: S) => this.stateDoc(this.fs.doc(`workspaces/${workspaceId}/state/${key}`), schema),
    };
  }

  top<N extends TopLevelName>(name: N): TopLevelRepo<N> {
    const schema = TOP_SCHEMAS[name] as unknown as z.ZodTypeAny;
    const coll = this.fs.collection(name);
    return {
      get: async (id) => {
        const snap = await coll.doc(id).get();
        return snap.exists ? (schema.parse(snap.data()) as TopLevelOf<N>) : null;
      },
      set: async (id, value) => {
        await coll.doc(id).set(stripUndefined(schema.parse(value)) as Doc);
      },
      update: async (id, patch) =>
        this.fs.runTransaction(async (tx) => {
          const ref = coll.doc(id);
          const snap = await tx.get(ref);
          if (!snap.exists) throw new DbError("NOT_FOUND", `${name}/${id} not found`);
          const v = schema.parse({ ...snap.data(), ...stripUndefined(patch as Doc), updatedAt: nowIso() }) as TopLevelOf<N>;
          tx.set(ref, stripUndefined(v) as Doc);
          return v;
        }),
      delete: async (id) => {
        await coll.doc(id).delete();
      },
      list: async (q) => runQuery(coll, q ?? {}, (d) => schema.parse(d) as TopLevelOf<N>),
    };
  }

  global<S extends z.ZodTypeAny>(key: string, schema: S): StateDoc<z.infer<S>> {
    return this.stateDoc(this.fs.doc(`ops/${key}`), schema);
  }

  private stateDoc<S extends z.ZodTypeAny>(ref: DocumentReference, schema: S): StateDoc<z.infer<S>> {
    return {
      get: async () => {
        const snap = await ref.get();
        return snap.exists ? (schema.parse(snap.data()) as z.infer<S>) : null;
      },
      set: async (value) => {
        await ref.set(stripUndefined(schema.parse(value)) as Doc);
      },
    };
  }

  async runTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.fs.runTransaction(async (t) => fn(new FirestoreTx(this.fs, t)), { maxAttempts: 8 });
  }

  async close(): Promise<void> {
    await this.fs.terminate();
  }
}

class FirestoreRepo<N extends EntityName> implements Repo<N> {
  private readonly coll;
  constructor(
    private readonly fs: Firestore,
    readonly workspaceId: string,
    readonly name: N,
  ) {
    assertCollection(name);
    this.coll = fs.collection(`workspaces/${workspaceId}/${name}`);
  }

  newId(): string {
    return newEntityId(this.name);
  }

  async get(id: string): Promise<EntityOf<N> | null> {
    const snap = await this.coll.doc(id).get();
    return snap.exists ? readEntity(this.name, snap.data()) : null;
  }

  async getOrThrow(id: string): Promise<EntityOf<N>> {
    const d = await this.get(id);
    if (!d) throw new DbError("NOT_FOUND", `${this.name}/${id} not found`);
    return d;
  }

  async getMany(ids: readonly string[]): Promise<EntityOf<N>[]> {
    if (ids.length === 0) return [];
    const snaps = await this.fs.getAll(...ids.map((id) => this.coll.doc(id)));
    return snaps.filter((s) => s.exists).map((s) => readEntity(this.name, s.data()));
  }

  async create(input: CreateInput<N>, opts: WriteOpts): Promise<EntityOf<N>> {
    const entity = buildEntity(this.name, this.workspaceId, input as Doc, opts.actor);
    try {
      await this.coll.doc((entity as { id: string }).id).create(stripUndefined(entity) as Doc);
    } catch (err) {
      if (isGrpcCode(err, 6)) throw new DbError("ALREADY_EXISTS", `${this.name}/${(entity as { id: string }).id} already exists`);
      throw err;
    }
    return entity;
  }

  async createIfAbsent(input: CreateInput<N> & { id: string }, opts: WriteOpts): Promise<{ entity: EntityOf<N>; created: boolean }> {
    const entity = buildEntity(this.name, this.workspaceId, input as Doc, opts.actor);
    try {
      await this.coll.doc(input.id).create(stripUndefined(entity) as Doc);
      return { entity, created: true };
    } catch (err) {
      if (!isGrpcCode(err, 6)) throw err;
      return { entity: await this.getOrThrow(input.id), created: false };
    }
  }

  async update(id: string, patch: Partial<EntityOf<N>>, opts: UpdateOpts): Promise<EntityOf<N>> {
    return this.fs.runTransaction(async (tx) => {
      const ref = this.coll.doc(id);
      const snap = await tx.get(ref);
      if (!snap.exists) throw new DbError("NOT_FOUND", `${this.name}/${id} not found`);
      const raw = snap.data() as Doc;
      if (opts.expectedUpdatedAt && raw.updatedAt !== opts.expectedUpdatedAt) {
        throw new DbError("CONFLICT", `${this.name}/${id} was modified concurrently`);
      }
      const merged = mergeEntity(this.name, readEntity(this.name, raw), patch as Doc);
      tx.set(ref, stripUndefined(merged) as Doc);
      return merged;
    });
  }

  async delete(id: string): Promise<void> {
    await this.coll.doc(id).delete();
  }

  async list(query: ListQuery = {}): Promise<Page<EntityOf<N>>> {
    return runQuery(this.coll, query, (d) => readEntity(this.name, d));
  }

  async findOne(where: readonly Where[]): Promise<EntityOf<N> | null> {
    return (await this.list({ where, limit: 1 })).items[0] ?? null;
  }

  watch(id: string, cb: (doc: EntityOf<N> | null) => void): () => void {
    return this.coll.doc(id).onSnapshot(
      (snap) => cb(snap.exists ? readEntity(this.name, snap.data()) : null),
      () => cb(null),
    );
  }
}

async function runQuery<T>(coll: FirebaseFirestore.CollectionReference, q: ListQuery, map: (d: Doc) => T): Promise<Page<T>> {
  let query: Query = coll;
  for (const [field, op, value] of q.where ?? []) query = query.where(field, op, value);
  if (q.orderBy) query = query.orderBy(q.orderBy.field, q.orderBy.dir ?? "asc");
  else query = query.orderBy(FieldPath.documentId());
  if (q.cursor) {
    const last = await coll.doc(decodeCursor(q.cursor)).get();
    if (last.exists) query = query.startAfter(last);
  }
  const limit = q.limit ?? 50;
  const snap = await query.limit(limit + 1).get();
  const docs = snap.docs.slice(0, limit);
  return {
    items: docs.map((d) => map(d.data() as Doc)),
    nextCursor: snap.docs.length > limit && docs.length ? encodeCursor(docs[docs.length - 1]!.id) : null,
  };
}

class FirestoreTx implements Tx {
  private wrote = false;
  private readonly reads = new Map<string, Doc | null>();
  constructor(
    private readonly fs: Firestore,
    private readonly t: Transaction,
  ) {}

  private async read(ref: DocumentReference): Promise<Doc | null> {
    if (this.wrote) throw new DbError("TX_READ_REQUIRED", "Transaction reads must happen before writes");
    const snap = await this.t.get(ref);
    const d = snap.exists ? (snap.data() as Doc) : null;
    this.reads.set(ref.path, d);
    return d;
  }

  async get<N extends EntityName>(workspaceId: string, name: N, id: string): Promise<EntityOf<N> | null> {
    assertCollection(name);
    const d = await this.read(this.fs.doc(`workspaces/${workspaceId}/${name}/${id}`));
    return d ? readEntity(name, d) : null;
  }
  async getState<S extends z.ZodTypeAny>(workspaceId: string, key: string, schema: S): Promise<z.infer<S> | null> {
    const d = await this.read(this.fs.doc(`workspaces/${workspaceId}/state/${key}`));
    return d ? schema.parse(d) : null;
  }
  async getGlobal<S extends z.ZodTypeAny>(key: string, schema: S): Promise<z.infer<S> | null> {
    const d = await this.read(this.fs.doc(`ops/${key}`));
    return d ? schema.parse(d) : null;
  }
  async getTop<N extends TopLevelName>(name: N, id: string): Promise<TopLevelOf<N> | null> {
    const d = await this.read(this.fs.doc(`${name}/${id}`));
    return d ? ((TOP_SCHEMAS[name] as unknown as z.ZodTypeAny).parse(d) as TopLevelOf<N>) : null;
  }
  create<N extends EntityName>(workspaceId: string, name: N, input: CreateInput<N>, opts: WriteOpts): EntityOf<N> {
    assertCollection(name);
    const entity = buildEntity(name, workspaceId, input as Doc, opts.actor);
    this.wrote = true;
    this.t.create(this.fs.doc(`workspaces/${workspaceId}/${name}/${(entity as { id: string }).id}`), stripUndefined(entity) as Doc);
    return entity;
  }
  update<N extends EntityName>(workspaceId: string, name: N, id: string, patch: Partial<EntityOf<N>>, _opts: WriteOpts): EntityOf<N> {
    const ref = this.fs.doc(`workspaces/${workspaceId}/${name}/${id}`);
    if (!this.reads.has(ref.path)) throw new DbError("TX_READ_REQUIRED", `Read ${name}/${id} in the transaction before updating it`);
    const prior = this.reads.get(ref.path);
    if (!prior) throw new DbError("NOT_FOUND", `${name}/${id} not found`);
    const merged = mergeEntity(name, readEntity(name, prior), patch as Doc);
    this.wrote = true;
    this.t.set(ref, stripUndefined(merged) as Doc);
    this.reads.set(ref.path, merged as Doc);
    return merged;
  }
  delete(workspaceId: string, name: EntityName, id: string): void {
    this.wrote = true;
    this.t.delete(this.fs.doc(`workspaces/${workspaceId}/${name}/${id}`));
  }
  setState<S extends z.ZodTypeAny>(workspaceId: string, key: string, schema: S, value: z.infer<S>): void {
    this.wrote = true;
    this.t.set(this.fs.doc(`workspaces/${workspaceId}/state/${key}`), stripUndefined(schema.parse(value)) as Doc);
  }
  setGlobal<S extends z.ZodTypeAny>(key: string, schema: S, value: z.infer<S>): void {
    this.wrote = true;
    this.t.set(this.fs.doc(`ops/${key}`), stripUndefined(schema.parse(value)) as Doc);
  }
  setTop<N extends TopLevelName>(name: N, id: string, value: TopLevelOf<N>): void {
    this.wrote = true;
    this.t.set(this.fs.doc(`${name}/${id}`), stripUndefined((TOP_SCHEMAS[name] as unknown as z.ZodTypeAny).parse(value)) as Doc);
  }
}
