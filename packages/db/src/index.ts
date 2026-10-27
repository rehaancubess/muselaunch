import { FirestoreDb } from "./firestore";
import { MemoryDb } from "./memory";
import type { Db } from "./types";

export * from "./types";
export { MemoryDb, queryDocs } from "./memory";
export { FirestoreDb, getFirebaseApp } from "./firestore";
export { INDEXES, assertIndexed, toFirestoreIndexesJson, type IndexDef } from "./indexes";
export { newId, newEntityId, nowIso, stripUndefined, validateEntity } from "./util";

export interface CreateDbOptions {
  driver?: "memory" | "firestore";
  projectId?: string;
  databaseId?: string;
}

let memorySingleton: MemoryDb | undefined;

/**
 * `DB_DRIVER=firestore` (default when GOOGLE_CLOUD_PROJECT / FIREBASE_PROJECT_ID is set) or `memory`.
 * The memory driver is process-local: fine for tests and single-process demos, not for API + worker
 * running as separate processes.
 */
export function createDb(opts: CreateDbOptions = {}): Db {
  const projectId = opts.projectId ?? process.env.FIREBASE_PROJECT_ID ?? process.env.GOOGLE_CLOUD_PROJECT;
  const driver = opts.driver ?? (process.env.DB_DRIVER as "memory" | "firestore" | undefined) ?? (projectId ? "firestore" : "memory");
  if (driver === "memory") {
    memorySingleton ??= new MemoryDb({ strictIndexes: process.env.DB_STRICT_INDEXES !== "0" });
    return memorySingleton;
  }
  return new FirestoreDb({ projectId, databaseId: opts.databaseId ?? process.env.FIRESTORE_DATABASE_ID });
}
