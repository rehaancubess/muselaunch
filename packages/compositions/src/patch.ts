import { Layer, PatchOp, type CompositionDoc, type Scene } from "@muselaunch/contracts";
import type { z } from "zod";
import { validateDoc } from "./validate";

export class PatchError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Invalid patch: ${errors.slice(0, 5).join("; ")}`);
    this.name = "PatchError";
    this.errors = errors;
  }
}

export interface ApplyResult {
  doc: CompositionDoc;
  /** Scenes whose content changed (or were added/removed/moved), in document order where possible. */
  affectedSceneIds: string[];
  /** Ops that undo this patch when applied to the result, in order. */
  inverse: PatchOp[];
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => (v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T));

/** Field names allowed per layer type (for rejecting unknown keys in update_layer). */
const LAYER_FIELDS: Record<string, Set<string>> = Object.fromEntries(
  (Layer.options as unknown as z.ZodObject[]).map((o) => {
    const shape = o.shape as Record<string, unknown>;
    const type = (shape.type as { value?: string; def?: { values?: string[] } }).value ?? (shape.type as { def: { values: string[] } }).def.values[0];
    return [type, new Set(Object.keys(shape))];
  }),
);

/**
 * Apply ops atomically. Every op must reference existing ids (or, for adds, new unique ids);
 * the whole result is re-validated. Throws PatchError and leaves the input untouched on failure.
 *
 * `update_layer.set` merges into the layer; nested plain objects (box, style, animation, timing, …)
 * merge one level deep. A `null` value removes an optional field (top level or nested), which is how
 * inverse ops restore fields that were previously absent.
 */
export function applyPatch(input: CompositionDoc, rawOps: PatchOp[]): ApplyResult {
  const errors: string[] = [];
  const ops: PatchOp[] = [];
  rawOps.forEach((op, i) => {
    const r = PatchOp.safeParse(op);
    if (!r.success) errors.push(...r.error.issues.slice(0, 5).map((x) => `ops.${i}.${x.path.join(".")}: ${x.message}`));
    else ops.push(r.data);
  });
  if (!rawOps.length) errors.push("ops: at least one op is required");
  if (errors.length) throw new PatchError(errors);

  const doc = clone(input);
  const inverse: PatchOp[] = [];
  const affected: string[] = [];
  const touch = (id: string) => {
    if (!affected.includes(id)) affected.push(id);
  };
  const allIds = () => {
    const s = new Set<string>();
    for (const sc of doc.scenes) {
      s.add(sc.id);
      for (const l of sc.layers) s.add(l.id);
    }
    return s;
  };
  const sceneIdx = (id: string, i: number) => {
    const idx = doc.scenes.findIndex((s) => s.id === id);
    if (idx < 0) throw new PatchError([`ops.${i}: unknown scene "${id}"`]);
    return idx;
  };
  const layerIdx = (scene: Scene, id: string, i: number) => {
    const idx = scene.layers.findIndex((l) => l.id === id);
    if (idx < 0) throw new PatchError([`ops.${i}: unknown layer "${id}" in scene "${scene.id}"`]);
    return idx;
  };

  ops.forEach((op, i) => {
    switch (op.op) {
      case "update_scene": {
        const scene = doc.scenes[sceneIdx(op.sceneId, i)]!;
        const prev: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(op.set)) {
          prev[k] = clone((scene as Record<string, unknown>)[k]);
          if (v === undefined) delete (scene as Record<string, unknown>)[k];
          else (scene as Record<string, unknown>)[k] = clone(v);
        }
        inverse.unshift({ op: "update_scene", sceneId: op.sceneId, set: prev as never });
        touch(op.sceneId);
        break;
      }
      case "add_scene": {
        const ids = allIds();
        if (ids.has(op.scene.id)) throw new PatchError([`ops.${i}: id "${op.scene.id}" already exists`]);
        for (const l of op.scene.layers) if (ids.has(l.id)) throw new PatchError([`ops.${i}: layer id "${l.id}" already exists`]);
        const at = op.afterSceneId === null ? 0 : sceneIdx(op.afterSceneId, i) + 1;
        doc.scenes.splice(at, 0, clone(op.scene));
        inverse.unshift({ op: "remove_scene", sceneId: op.scene.id });
        touch(op.scene.id);
        break;
      }
      case "remove_scene": {
        const idx = sceneIdx(op.sceneId, i);
        const [removed] = doc.scenes.splice(idx, 1);
        inverse.unshift({ op: "add_scene", scene: removed!, afterSceneId: idx === 0 ? null : doc.scenes[idx - 1]!.id });
        touch(op.sceneId);
        break;
      }
      case "move_scene": {
        const idx = sceneIdx(op.sceneId, i);
        if (op.afterSceneId === op.sceneId) throw new PatchError([`ops.${i}: cannot move a scene after itself`]);
        const prevAfter = idx === 0 ? null : doc.scenes[idx - 1]!.id;
        const [moved] = doc.scenes.splice(idx, 1);
        const at = op.afterSceneId === null ? 0 : sceneIdx(op.afterSceneId, i) + 1;
        doc.scenes.splice(at, 0, moved!);
        inverse.unshift({ op: "move_scene", sceneId: op.sceneId, afterSceneId: prevAfter });
        touch(op.sceneId);
        break;
      }
      case "add_layer": {
        const scene = doc.scenes[sceneIdx(op.sceneId, i)]!;
        if (allIds().has(op.layer.id)) throw new PatchError([`ops.${i}: id "${op.layer.id}" already exists`]);
        const at = op.index === undefined ? scene.layers.length : Math.min(op.index, scene.layers.length);
        scene.layers.splice(at, 0, clone(op.layer));
        inverse.unshift({ op: "remove_layer", sceneId: op.sceneId, layerId: op.layer.id });
        touch(op.sceneId);
        break;
      }
      case "update_layer": {
        const scene = doc.scenes[sceneIdx(op.sceneId, i)]!;
        const li = layerIdx(scene, op.layerId, i);
        const layer = scene.layers[li]! as Record<string, unknown>;
        if ("id" in op.set) throw new PatchError([`ops.${i}: update_layer cannot change "id"`]);
        if ("type" in op.set) throw new PatchError([`ops.${i}: update_layer cannot change "type"`]);
        const fields = LAYER_FIELDS[layer.type as string];
        const unknown = Object.keys(op.set).filter((k) => !fields?.has(k));
        if (unknown.length) throw new PatchError([`ops.${i}: unknown field(s) for ${String(layer.type)} layer: ${unknown.join(", ")}`]);
        const prev: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(op.set)) {
          const old = layer[k];
          if (isPlainObject(v) && isPlainObject(old)) {
            // Nested merge: remember previous values of the touched sub-keys (null = was absent).
            const prevNested: Record<string, unknown> = {};
            const merged: Record<string, unknown> = { ...old };
            for (const [nk, nv] of Object.entries(v)) {
              prevNested[nk] = nk in old && old[nk] !== undefined ? clone(old[nk]) : null;
              if (nv === null || nv === undefined) delete merged[nk];
              else merged[nk] = clone(nv);
            }
            prev[k] = prevNested;
            layer[k] = merged;
          } else {
            prev[k] = old === undefined ? null : clone(old);
            if (v === null || v === undefined) delete layer[k];
            else layer[k] = clone(v);
          }
        }
        const reparsed = Layer.safeParse(layer);
        if (!reparsed.success) {
          throw new PatchError(reparsed.error.issues.slice(0, 8).map((x) => `ops.${i} (${op.layerId}).${x.path.join(".")}: ${x.message}`));
        }
        scene.layers[li] = reparsed.data;
        inverse.unshift({ op: "update_layer", sceneId: op.sceneId, layerId: op.layerId, set: prev });
        touch(op.sceneId);
        break;
      }
      case "remove_layer": {
        const scene = doc.scenes[sceneIdx(op.sceneId, i)]!;
        const li = layerIdx(scene, op.layerId, i);
        const [removed] = scene.layers.splice(li, 1);
        inverse.unshift({ op: "add_layer", sceneId: op.sceneId, layer: removed!, index: li });
        touch(op.sceneId);
        break;
      }
      case "reorder_layer": {
        const scene = doc.scenes[sceneIdx(op.sceneId, i)]!;
        const li = layerIdx(scene, op.layerId, i);
        const [l] = scene.layers.splice(li, 1);
        scene.layers.splice(Math.min(op.toIndex, scene.layers.length), 0, l!);
        inverse.unshift({ op: "reorder_layer", sceneId: op.sceneId, layerId: op.layerId, toIndex: li });
        touch(op.sceneId);
        break;
      }
      case "update_theme": {
        const prev: Record<string, unknown> = {};
        const theme = doc.theme as Record<string, unknown>;
        for (const [k, v] of Object.entries(op.set)) {
          prev[k] = clone(theme[k]);
          if (v === undefined) delete theme[k];
          else theme[k] = v;
        }
        inverse.unshift({ op: "update_theme", set: prev as never });
        for (const s of doc.scenes) touch(s.id);
        break;
      }
      case "upsert_audio": {
        const idx = doc.audio.findIndex((a) => a.id === op.track.id);
        if (idx >= 0) {
          inverse.unshift({ op: "upsert_audio", track: clone(doc.audio[idx]!) });
          doc.audio[idx] = clone(op.track);
        } else {
          inverse.unshift({ op: "remove_audio", trackId: op.track.id });
          doc.audio.push(clone(op.track));
        }
        break;
      }
      case "remove_audio": {
        const idx = doc.audio.findIndex((a) => a.id === op.trackId);
        if (idx < 0) throw new PatchError([`ops.${i}: unknown audio track "${op.trackId}"`]);
        const [removed] = doc.audio.splice(idx, 1);
        inverse.unshift({ op: "upsert_audio", track: removed! });
        break;
      }
      case "set_captions": {
        inverse.unshift({ op: "set_captions", captions: clone(doc.captions) });
        doc.captions = clone(op.captions);
        break;
      }
    }
  });

  const v = validateDoc(doc);
  if (!v.ok) throw new PatchError(v.errors);
  const order = new Map(v.doc.scenes.map((s, i) => [s.id, i]));
  affected.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  return { doc: v.doc, affectedSceneIds: affected, inverse };
}
