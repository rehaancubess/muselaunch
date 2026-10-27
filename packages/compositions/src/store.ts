/**
 * Persistence for compositions and their immutable versions (`@muselaunch/compositions/store`).
 *
 * Version docs use the id `${compositionId}_v${version}`. `currentVersion` is what the editor
 * shows (moves back on undo); `latestVersion` is the highest version ever written. A new commit
 * always gets `latestVersion + 1`, branches from `baseVersion`, and clears the redo stack.
 */
import type { Composition, CompositionDoc, CompositionVersion } from "@muselaunch/contracts";
import { DbError, newEntityId, type WorkspaceDb } from "@muselaunch/db";
import { docHash, sceneHashes } from "./hash";
import { validateDoc } from "./validate";

/** Errors are DbErrors (NOT_FOUND / CONFLICT / INVALID) so the platform maps them to 404 / 409 / 422. */
const fail = (code: "NOT_FOUND" | "CONFLICT" | "INVALID", message: string, details?: unknown) => new DbError(code, message, details);

export const versionDocId = (compositionId: string, version: number) => `${compositionId}_v${version}`;

function validated(doc: CompositionDoc): CompositionDoc {
  const v = validateDoc(doc);
  if (!v.ok) throw fail("INVALID", `Invalid composition: ${v.errors.slice(0, 5).join("; ")}`, v.errors);
  return v.doc;
}

function statusFor(c: Pick<Composition, "lastRender" | "status" | "approvedVersion">, version: number): Composition["status"] {
  if (c.status === "rendering") return "rendering";
  if (c.approvedVersion === version) return "approved";
  return c.lastRender?.version === version && c.status !== "failed" ? "rendered" : "draft";
}

export async function createComposition(
  ws: WorkspaceDb,
  input: {
    appId: string;
    campaignId?: string;
    variantId?: string;
    storyboardId?: string;
    title: string;
    doc: CompositionDoc;
    derivedFromCompositionId?: string;
    id?: string;
  },
  actor: string,
): Promise<{ composition: Composition; version: CompositionVersion }> {
  const doc = validated(input.doc);
  const id = input.id ?? newEntityId("compositions");
  const comps = ws.collection("compositions");
  const versions = ws.collection("compositionVersions");
  // Version first: if we crash between the writes, a rerun with the same id completes the pair.
  const { entity: version } = await versions.createIfAbsent(
    {
      id: versionDocId(id, 1),
      compositionId: id,
      version: 1,
      parentVersion: null,
      doc,
      source: input.derivedFromCompositionId ? "duplicate" : "generated",
      summary: input.derivedFromCompositionId ? `Derived from ${input.derivedFromCompositionId}` : "Initial version",
      contentHash: docHash(doc),
      sceneHashes: sceneHashes(doc),
    },
    { actor },
  );
  const { entity: composition } = await comps.createIfAbsent(
    {
      id,
      appId: input.appId,
      campaignId: input.campaignId,
      variantId: input.variantId,
      storyboardId: input.storyboardId,
      derivedFromCompositionId: input.derivedFromCompositionId,
      title: input.title.slice(0, 200),
      kind: doc.kind,
      aspectRatio: doc.aspectRatio,
      currentVersion: 1,
      latestVersion: 1,
      redoStack: [],
      status: "draft",
    },
    { actor },
  );
  return { composition, version };
}

export async function commitVersion(
  ws: WorkspaceDb,
  compositionId: string,
  input: { baseVersion: number; doc: CompositionDoc; source: CompositionVersion["source"]; summary: string; patchId?: string },
  actor: string,
): Promise<{ composition: Composition; version: CompositionVersion }> {
  const comps = ws.collection("compositions");
  const comp = await comps.get(compositionId);
  if (!comp) throw fail("NOT_FOUND", `Composition ${compositionId} not found`);
  if (input.baseVersion !== comp.currentVersion) {
    throw fail("CONFLICT", `Composition is at version ${comp.currentVersion}, edit was based on version ${input.baseVersion}`, {
      currentVersion: comp.currentVersion,
      baseVersion: input.baseVersion,
    });
  }
  const doc = validated(input.doc);
  const next = comp.latestVersion + 1;
  let version: CompositionVersion;
  try {
    version = await ws.collection("compositionVersions").create(
      {
        id: versionDocId(compositionId, next),
        compositionId,
        version: next,
        parentVersion: input.baseVersion,
        doc,
        patchId: input.patchId,
        source: input.source,
        summary: input.summary.slice(0, 500),
        contentHash: docHash(doc),
        sceneHashes: sceneHashes(doc),
      },
      { actor },
    );
  } catch (err) {
    if (err instanceof DbError && err.code === "ALREADY_EXISTS") throw fail("CONFLICT", "Another edit was saved at the same time; reload and retry");
    throw err;
  }
  try {
    const composition = await comps.update(
      compositionId,
      { currentVersion: next, latestVersion: next, redoStack: [], status: statusFor(comp, next), title: doc.title.slice(0, 200) || comp.title, kind: doc.kind, aspectRatio: doc.aspectRatio },
      { actor, expectedUpdatedAt: comp.updatedAt },
    );
    return { composition, version };
  } catch (err) {
    if (err instanceof DbError && err.code === "CONFLICT") {
      await ws.collection("compositionVersions").delete(version.id).catch(() => {});
      throw fail("CONFLICT", "Another edit was saved at the same time; reload and retry");
    }
    throw err;
  }
}

export async function getVersion(ws: WorkspaceDb, compositionId: string, version?: number): Promise<CompositionVersion> {
  let v = version;
  if (v === undefined) {
    const comp = await ws.collection("compositions").get(compositionId);
    if (!comp) throw fail("NOT_FOUND", `Composition ${compositionId} not found`);
    v = comp.currentVersion;
  }
  const doc = await ws.collection("compositionVersions").get(versionDocId(compositionId, v));
  if (!doc || doc.compositionId !== compositionId) throw fail("NOT_FOUND", `Version ${v} of composition ${compositionId} not found`);
  return doc;
}

export async function undo(ws: WorkspaceDb, compositionId: string, actor: string): Promise<Composition> {
  const comps = ws.collection("compositions");
  const comp = await comps.get(compositionId);
  if (!comp) throw fail("NOT_FOUND", `Composition ${compositionId} not found`);
  const cur = await getVersion(ws, compositionId, comp.currentVersion);
  if (cur.parentVersion === null) throw fail("CONFLICT", "Nothing to undo");
  try {
    return await comps.update(
      compositionId,
      { currentVersion: cur.parentVersion, redoStack: [...comp.redoStack, comp.currentVersion], status: statusFor(comp, cur.parentVersion) },
      { actor, expectedUpdatedAt: comp.updatedAt },
    );
  } catch (err) {
    if (err instanceof DbError && err.code === "CONFLICT") throw fail("CONFLICT", "The composition changed; reload and retry");
    throw err;
  }
}

export async function redo(ws: WorkspaceDb, compositionId: string, actor: string): Promise<Composition> {
  const comps = ws.collection("compositions");
  const comp = await comps.get(compositionId);
  if (!comp) throw fail("NOT_FOUND", `Composition ${compositionId} not found`);
  const target = comp.redoStack[comp.redoStack.length - 1];
  if (target === undefined) throw fail("CONFLICT", "Nothing to redo");
  const v = await getVersion(ws, compositionId, target);
  if (v.parentVersion !== comp.currentVersion) throw fail("CONFLICT", "Redo history no longer matches the current version");
  try {
    return await comps.update(
      compositionId,
      { currentVersion: target, redoStack: comp.redoStack.slice(0, -1), status: statusFor(comp, target) },
      { actor, expectedUpdatedAt: comp.updatedAt },
    );
  } catch (err) {
    if (err instanceof DbError && err.code === "CONFLICT") throw fail("CONFLICT", "The composition changed; reload and retry");
    throw err;
  }
}

/** Revert = commit an older version's doc as a new version (keeps history linear and auditable). */
export async function revertTo(ws: WorkspaceDb, compositionId: string, targetVersion: number, actor: string) {
  const comp = await ws.collection("compositions").getOrThrow(compositionId);
  const target = await getVersion(ws, compositionId, targetVersion);
  return commitVersion(ws, compositionId, { baseVersion: comp.currentVersion, doc: target.doc, source: "revert", summary: `Reverted to version ${targetVersion}` }, actor);
}
