import { randomBytes } from "node:crypto";
import { ENTITY_SCHEMAS, ID_PREFIX, type EntityName, type EntityOf } from "@muselaunch/contracts";
import type { z } from "zod";
import { DbError } from "./types";

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/** Time-sortable id: `<prefix>_<10 chars time><12 chars random>` (Crockford base32, lowercase). */
export function newId(prefix: string): string {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(12);
  let rand = "";
  for (let i = 0; i < 12; i++) rand += CROCKFORD[bytes[i]! % 32];
  return `${prefix}_${time}${rand}`;
}

export function newEntityId(name: EntityName): string {
  return newId(ID_PREFIX[name]);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function assertCollection(name: string): asserts name is EntityName {
  if (!(name in ENTITY_SCHEMAS)) throw new DbError("FORBIDDEN_COLLECTION", `Unknown collection "${name}"`);
}

export function assertWorkspaceId(id: string): void {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new DbError("INVALID", "Invalid workspace id");
}

export function schemaFor<N extends EntityName>(name: N): z.ZodTypeAny {
  return ENTITY_SCHEMAS[name] as unknown as z.ZodTypeAny;
}

/** Validate a full entity document, applying schema defaults. */
export function validateEntity<N extends EntityName>(name: N, doc: unknown): EntityOf<N> {
  const parsed = schemaFor(name).safeParse(doc);
  if (!parsed.success) {
    throw new DbError("INVALID", `Invalid ${name} document: ${formatIssues(parsed.error)}`, parsed.error.issues);
  }
  return parsed.data as EntityOf<N>;
}

/** Lenient read: apply defaults when possible, otherwise return raw (logged by caller). */
export function readEntity<N extends EntityName>(name: N, doc: unknown): EntityOf<N> {
  const parsed = schemaFor(name).safeParse(doc);
  if (parsed.success) return parsed.data as EntityOf<N>;
  if (process.env.MUSELAUNCH_STRICT_READS === "1") {
    throw new DbError("INVALID", `Stored ${name} document failed validation: ${formatIssues(parsed.error)}`);
  }
  return doc as EntityOf<N>;
}

export function formatIssues(err: z.ZodError): string {
  return err.issues
    .slice(0, 6)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

/** Remove `undefined` recursively (Firestore rejects undefined; JSON drops it). */
export function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripUndefined(v)) as unknown as T;
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

export function buildEntity<N extends EntityName>(
  name: N,
  workspaceId: string,
  input: Record<string, unknown>,
  actor: string,
  id?: string,
): EntityOf<N> {
  const ts = nowIso();
  const { id: inputId, ...rest } = input as { id?: string };
  return validateEntity(name, {
    ...rest,
    id: id ?? inputId ?? newEntityId(name),
    workspaceId,
    createdAt: ts,
    updatedAt: ts,
    createdBy: actor,
  });
}

/** Merge a patch into an existing entity, protecting system fields. */
export function mergeEntity<N extends EntityName>(name: N, existing: EntityOf<N>, patch: Record<string, unknown>): EntityOf<N> {
  const { id: _i, workspaceId: _w, createdAt: _c, createdBy: _b, ...safe } = patch;
  return validateEntity(name, { ...(existing as object), ...safe, updatedAt: nowIso() });
}

export function encodeCursor(id: string): string {
  return Buffer.from(id, "utf8").toString("base64url");
}
export function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, "base64url").toString("utf8");
}

export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
