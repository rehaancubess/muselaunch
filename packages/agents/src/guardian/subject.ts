import type { BrandFinding, BrandReviewSubjectEntity, Channel, Composition, CompositionDoc, CompositionVersion, CopyPack, EntityRef, MediaAsset, OutreachDraft, ScheduledPost } from "@muselaunch/contracts";
import { canonicalJson, collectAssetRefs, describeForLLM, totalDuration } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import type { WorkspaceDb } from "@muselaunch/db";
import { AppError } from "@muselaunch/platform";
import { clip, sha256 } from "../util";

export const SUBJECT_ENTITIES: readonly BrandReviewSubjectEntity[] = ["compositions", "copyPacks", "outreachDrafts", "scheduledPosts"];

/** One piece of copy the guardian checks (text layer, caption cue, copy item, draft field, post field). */
export interface SubjectText {
  id: string;
  text: string;
  kind: string;
  where: NonNullable<BrandFinding["location"]>;
  claimIds: string[];
}

/** The exact content under review, normalised across subject kinds. */
export interface LoadedSubject {
  ref: { entity: BrandReviewSubjectEntity; id: string };
  appId: string;
  title: string;
  /** Composition version (compositions only). */
  version?: number;
  /** Hash of exactly what is reviewed; a review is reused only for the same hash. */
  contentHash: string;
  /** Channels the asset is meant for (campaign channels, scheduled posts, copy pack channel). */
  channels: Channel[];
  texts: SubjectText[];
  composition?: { comp: Composition; version: CompositionVersion; doc: CompositionDoc };
  copyPack?: CopyPack;
  draft?: OutreachDraft;
  post?: ScheduledPost;
  /** Media referenced by the subject (product-truth / synthetic-media checks). */
  assets: Map<string, MediaAsset>;
}

const hashContent = (v: unknown) => `sha256:${sha256(canonicalJson(v))}`;

export function isSubjectEntity(x: string): x is BrandReviewSubjectEntity {
  return (SUBJECT_ENTITIES as readonly string[]).includes(x);
}

async function campaignChannels(ws: WorkspaceDb, campaignId: string | undefined): Promise<Channel[]> {
  if (!campaignId) return [];
  const c = await ws.collection("campaigns").get(campaignId);
  return c?.channels ?? [];
}

/**
 * Load the subject of a review from this workspace only (tenancy: `ws` is already scoped).
 * `version` applies to compositions; other subjects are reviewed at their current content.
 */
export async function loadSubject(ws: WorkspaceDb, ref: EntityRef, version?: number): Promise<LoadedSubject> {
  if (!isSubjectEntity(ref.entity)) throw new AppError("BAD_REQUEST", `Brand Guardian can't review ${ref.entity}`);
  switch (ref.entity) {
    case "compositions": {
      const comp = await ws.collection("compositions").getOrThrow(ref.id);
      const ver = await getVersion(ws, comp.id, version ?? comp.currentVersion);
      const doc = ver.doc;
      const texts: SubjectText[] = [];
      for (const s of doc.scenes) {
        for (const l of s.layers) {
          if (l.type === "text" && !l.hidden) texts.push({ id: l.id, text: l.text, kind: l.role, where: { sceneId: s.id, layerId: l.id }, claimIds: l.claimIds });
        }
      }
      if (doc.captions.enabled) for (const cue of doc.captions.cues) texts.push({ id: cue.id, text: cue.text, kind: "caption_cue", where: { field: `captions.${cue.id}`.slice(0, 80) }, claimIds: [] });
      const refs = collectAssetRefs(doc);
      const assets = (await ws.collection("mediaAssets").getMany(refs.assetIds)) as MediaAsset[];
      // Target channels: the campaign's, plus any channel this composition is scheduled on.
      const posts = (await ws.collection("scheduledPosts").list({ where: [["appId", "==", comp.appId]], orderBy: { field: "createdAt", dir: "desc" }, limit: 200 })).items.filter((x) => x.compositionId === comp.id);
      const channels = [...new Set([...(await campaignChannels(ws, comp.campaignId)), ...posts.map((x) => x.channel)])];
      return {
        ref: { entity: "compositions", id: comp.id },
        appId: comp.appId,
        title: comp.title,
        version: ver.version,
        contentHash: ver.contentHash,
        channels,
        texts,
        composition: { comp, version: ver, doc },
        assets: new Map(assets.map((a) => [a.id, a])),
      };
    }
    case "copyPacks": {
      const pack = await ws.collection("copyPacks").getOrThrow(ref.id);
      return {
        ref: { entity: "copyPacks", id: pack.id },
        appId: pack.appId,
        title: `${pack.channel} copy`,
        contentHash: hashContent({ k: "copyPack", channel: pack.channel, locale: pack.locale, items: pack.items.map((i) => ({ id: i.id, kind: i.kind, text: i.text, claimIds: i.claimIds })) }),
        channels: [pack.channel],
        texts: pack.items.map((i) => ({ id: i.id, text: i.text, kind: i.kind, where: { copyItemId: i.id.slice(0, 40) }, claimIds: i.claimIds })),
        copyPack: pack,
        assets: new Map(),
      };
    }
    case "outreachDrafts": {
      const d = await ws.collection("outreachDrafts").getOrThrow(ref.id);
      const texts: SubjectText[] = [];
      if (d.subject) texts.push({ id: "subject", text: d.subject, kind: "subject", where: { field: "subject" }, claimIds: d.claimIds });
      texts.push({ id: "body", text: d.body, kind: "body", where: { field: "body" }, claimIds: d.claimIds });
      if (d.offer) texts.push({ id: "offer", text: d.offer, kind: "offer", where: { field: "offer" }, claimIds: [] });
      return {
        ref: { entity: "outreachDrafts", id: d.id },
        appId: d.appId,
        title: clip(d.subject ?? "Outreach draft", 120),
        contentHash: hashContent({ k: "outreachDraft", subject: d.subject, body: d.body, offer: d.offer, claimIds: d.claimIds }),
        channels: [],
        texts,
        draft: d,
        assets: new Map(),
      };
    }
    case "scheduledPosts": {
      const post = await ws.collection("scheduledPosts").getOrThrow(ref.id);
      const texts: SubjectText[] = [];
      if (post.title) texts.push({ id: "title", text: post.title, kind: "title", where: { field: "title" }, claimIds: [] });
      if (post.caption.trim()) texts.push({ id: "caption", text: post.caption, kind: "caption", where: { field: "caption" }, claimIds: [] });
      if (post.tags.length) texts.push({ id: "tags", text: post.tags.join(" "), kind: "hashtags", where: { field: "tags" }, claimIds: [] });
      const assets = (await ws.collection("mediaAssets").getMany(post.assetIds)) as MediaAsset[];
      return {
        ref: { entity: "scheduledPosts", id: post.id },
        appId: post.appId,
        title: clip(post.title ?? post.caption ?? "Post", 120) || "Post",
        contentHash: hashContent({
          k: "scheduledPost",
          channel: post.channel,
          title: post.title,
          caption: post.caption,
          tags: post.tags,
          assetIds: post.assetIds,
          compositionId: post.compositionId,
          compositionVersion: post.compositionVersion,
          containsSyntheticMedia: post.containsSyntheticMedia,
        }),
        channels: [post.channel],
        texts,
        post,
        assets: new Map(assets.map((a) => [a.id, a])),
      };
    }
  }
}

/** Content block for the Glimmer packet (wrapped as untrusted data by the caller). */
export function describeSubject(s: LoadedSubject): string {
  if (s.composition) {
    const { doc } = s.composition;
    return `Composition "${s.title}" version ${s.version} (${doc.kind}, ${doc.aspectRatio}, ${Math.round(totalDuration(doc) * 10) / 10}s)${s.channels.length ? ` for ${s.channels.join(", ")}` : ""}\n${describeForLLM(doc)}`;
  }
  if (s.copyPack) {
    return [`Copy pack for ${s.copyPack.channel} (${s.copyPack.locale}). Items (id | kind | text):`, ...s.copyPack.items.map((i) => `- ${i.id} | ${i.kind} | ${JSON.stringify(clip(i.text, 2500))}${i.claimIds.length ? ` | claims ${i.claimIds.join(",")}` : ""}`)].join("\n");
  }
  if (s.draft) {
    return [`Creator outreach draft (${s.draft.channel}). Fields:`, ...s.texts.map((t) => `- ${t.id}: ${JSON.stringify(clip(t.text, 6000))}`)].join("\n");
  }
  if (s.post) {
    const p = s.post;
    return [`Scheduled ${p.channel} post (${p.mode}, visibility ${p.visibility}${p.containsSyntheticMedia ? ", discloses synthetic media" : ""}). Fields:`, ...s.texts.map((t) => `- ${t.id}: ${JSON.stringify(clip(t.text, 5000))}`)].join("\n");
  }
  return s.texts.map((t) => `- ${t.id}: ${JSON.stringify(t.text)}`).join("\n");
}

/** A short query describing the subject, for memory retrieval. */
export function subjectQuery(s: LoadedSubject): string {
  return clip(`${s.title}. ${s.texts.map((t) => t.text).join(" · ")}`, 1500);
}

/** Text layer lookup for compositions (locations + suggested ops). */
export function findLayer(doc: CompositionDoc, layerId: string) {
  for (const scene of doc.scenes) {
    const layer = scene.layers.find((l) => l.id === layerId);
    if (layer) return { scene, layer };
  }
  return null;
}
