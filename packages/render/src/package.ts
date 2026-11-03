/**
 * package.export: a ZIP the user can publish from by hand — final videos, posters, SRT captions,
 * static slides, copy packs, publishing instructions and an attribution/licence list.
 * Nothing is posted anywhere; this is the honest alternative while social OAuth is pending.
 */
import { zipSync, strToU8, type Zippable } from "fflate";
import { AI_VOICE_CAPTION_LINE, fillAppLink, TEXT_POST_LIMITS, withAiVoiceLine, type AttributionLink, type Composition, type CompositionDoc, type CopyPack, type MediaAsset, type Storyboard } from "@muselaunch/contracts";
import { collectAssetRefs, docHash } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import { AppError, assertKeyInWorkspace, safeFilename, trackedLinkUrl, workspaceKey, type JobContext } from "@muselaunch/platform";
import { renderCacheKey } from "./keys";
import { extFor, shortHash, toSrt } from "./media";
import { finalStillEncoding, stillKindOf, type StillKind } from "./stills";

const CHANNEL_SPECS: Record<string, string> = {
  instagram: "Instagram Reels: 9:16 MP4, up to 90 s. Add the caption + hashtags from copy/instagram.txt. Upload the SRT or use auto-captions.",
  tiktok: "TikTok: 9:16 MP4. Paste the caption from copy/tiktok.txt; keep key text inside the safe zone (already applied).",
  youtube: "YouTube Shorts: 9:16 MP4 ≤ 60 s. Title + description from copy/youtube.txt. Upload captions.srt under Subtitles.",
  linkedin: "LinkedIn: 1:1 or 9:16 MP4 (16:9 also fine). Post text from copy/linkedin.txt. Upload the SRT for captions.",
  x: "X: 16:9 or 1:1 MP4 ≤ 2:20. Post text from copy/x.txt.",
  facebook: "Facebook Reels: 9:16 MP4. Caption from copy/facebook.txt.",
  threads: "Threads: 9:16 or 1:1 MP4. Text from copy/threads.txt.",
  producthunt: "Product Hunt: use the 16:9 video and stills in the gallery; tagline/description/maker comment are in copy/producthunt.txt.",
  reddit: "Reddit: follow each community's self-promotion rules; post text in copy/reddit.txt.",
};

/** Where each kind of still goes in the package, and what the folder's notes say. */
const STORE_FOLDER: Record<"store_ios" | "store_android", { dir: string; readme: string }> = {
  store_ios: {
    dir: "app-store",
    readme: [
      "App Store screenshots (6.9-inch iPhone, 1290 x 2796 PNG, no transparency).",
      "Upload them in App Store Connect: your app > the version > Previews and Screenshots > iPhone 6.9\" Display.",
      "Drag the slides in this order (slide-01 first). Up to 10 per language.",
    ].join("\n"),
  },
  store_android: {
    dir: "google-play",
    readme: [
      "Google Play phone screenshots (1080 x 1920 PNG, no transparency).",
      "Upload them in Play Console: Grow users > Store presence > Main store listing > Phone screenshots.",
      "Add the slides in this order (slide-01 first). 2 to 8 screenshots; 4 or more at this size can be featured.",
    ].join("\n"),
  },
};

const CAROUSEL_NOTES = "Carousels: upload the slides in this order (slide-01 first). Instagram crops every slide to the first one's shape, and takes at most 10.";

/** Channels a voiceover line is added to (X's 280-character limit is kept). */
const CHANNEL_LIMIT: Record<string, number | undefined> = { x: TEXT_POST_LIMITS.x, threads: TEXT_POST_LIMITS.threads, linkedin: TEXT_POST_LIMITS.linkedin };

/**
 * Copy for a video whose voiceover is external TTS: the caption-like items (caption, description,
 * thread) carry the AI-voice line once, kept within the channel's limit (X: 280).
 */
export function withAiVoiceCopy(pack: CopyPack): CopyPack {
  const limit = CHANNEL_LIMIT[pack.channel];
  return { ...pack, items: pack.items.map((it) => (it.kind === "caption" || it.kind === "description" || it.kind === "thread" ? { ...it, text: withAiVoiceLine(it.text, limit) } : it)) };
}

/** A doc whose voiceover is an external TTS voice (needs the AI-voice line in its posts). */
export const usesAiVoice = (doc: CompositionDoc) => doc.audio.some((t) => t.kind === "voiceover" && t.sourceLabel === "external_tts");

const slug = (s: string) => safeFilename(s.toLowerCase().replace(/[^a-z0-9]+/g, "-")).replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "video";

function licenseLine(a: MediaAsset): string {
  const lic = a.license;
  const parts = [`- ${a.title ?? a.originalFilename ?? a.id} (${a.role}, ${a.origin})`];
  if (a.isProductTruth) parts.push("real product media supplied by you");
  if (a.generation) parts.push(`generated with ${a.generation.provider} ${a.generation.model}`);
  if (a.role === "tts") parts.push("synthetic voice (external TTS) — disclose where required");
  if (lic) {
    parts.push(`licence: ${lic.type}${lic.provider ? ` via ${lic.provider}` : ""}`);
    if (lic.attribution) parts.push(`attribution: ${lic.attribution}`);
    if (lic.sourceUrl) parts.push(`source: ${lic.sourceUrl}`);
    if (lic.restrictions) parts.push(`restrictions: ${lic.restrictions}`);
  } else parts.push("licence: not recorded — confirm you have the rights before publishing");
  return parts.join("; ");
}

export async function exportPackage(ctx: JobContext<"package.export">) {
  const p = ctx.platform;
  const wid = ctx.workspaceId;
  const { appId, campaignId, includeCopy } = ctx.payload;
  const campaign = await ctx.ws.collection("campaigns").getOrThrow(campaignId);
  if (campaign.appId !== appId) throw new AppError("BAD_REQUEST", "Campaign belongs to another app");
  const app = await ctx.ws.collection("apps").getOrThrow(appId);

  let comps: Composition[];
  if (ctx.payload.compositionIds.length) comps = (await ctx.ws.collection("compositions").getMany(ctx.payload.compositionIds)) as Composition[];
  else comps = (await ctx.ws.collection("compositions").list({ where: [["campaignId", "==", campaignId]], limit: 100 })).items;
  comps = comps.filter((c) => c.campaignId === campaignId || ctx.payload.compositionIds.includes(c.id));
  if (!comps.length) throw new AppError("VALIDATION_FAILED", "This campaign has no compositions to export");

  await ctx.progress(5, "collecting renders");
  const files: Zippable = {};
  const manifest: Record<string, unknown>[] = [];
  const missing: string[] = [];
  const sourceAssets = new Map<string, MediaAsset>();
  const included: string[] = [];
  const fetchAsset = async (a: MediaAsset) => {
    assertKeyInWorkspace(wid, a.storagePath);
    return new Uint8Array(await p.storage.get(a.storagePath));
  };

  const stillKinds = new Set<StillKind>();
  const aiVoiceVariants = new Set<string>();
  let aiVoiceCampaign = false;
  for (const [i, comp] of comps.entries()) {
    ctx.throwIfCancelled();
    await ctx.progress(5 + (i / comps.length) * 60, `packaging ${comp.title}`);
    const ver = await getVersion(ctx.ws, comp.id, comp.approvedVersion ?? comp.currentVersion);
    const doc: CompositionDoc = ver.doc;
    const isVideo = doc.kind === "video";
    const storyboard = !isVideo && comp.storyboardId ? ((await ctx.ws.collection("storyboards").get(comp.storyboardId)) as Storyboard | null) : null;
    // Stills are keyed by the encoding the render produced for their kind (./stills.ts); older still
    // renders were PNG for every kind, so those are found too.
    const keys = isVideo ? [renderCacheKey(docHash(doc), "final", "mp4")] : [...new Set([finalStillEncoding(doc, "png", storyboard), "png", "jpeg"])].map((f) => renderCacheKey(docHash(doc), "final", f));
    let main: MediaAsset | null = null;
    for (const key of keys) {
      const a = await ctx.ws.collection("mediaAssets").get(`ast_r_${key}`);
      if (a && a.status === "ready") {
        main = a;
        break;
      }
    }
    const name = `${slug(comp.title)}-${doc.aspectRatio.replace(":", "x")}`;
    if (!main || main.status !== "ready") {
      missing.push(`${comp.title} (${doc.aspectRatio}, v${ver.version})`);
      continue;
    }
    const entry: Record<string, unknown> = { compositionId: comp.id, title: comp.title, version: ver.version, aspectRatio: doc.aspectRatio, kind: doc.kind, files: [] as string[] };
    const add = (path: string, data: Uint8Array, level: 0 | 6 = 6) => {
      files[path] = [data, { level }];
      (entry.files as string[]).push(path);
    };
    if (isVideo) {
      add(`videos/${name}.mp4`, await fetchAsset(main), 0);
      included.push(main.id);
      if (main.posterAssetId) {
        const poster = await ctx.ws.collection("mediaAssets").get(main.posterAssetId);
        if (poster) add(`thumbnails/${name}.jpg`, await fetchAsset(poster), 0);
      }
      if (doc.captions.cues.length) add(`captions/${name}.srt`, strToU8(toSrt(doc.captions.cues)));
      if (usesAiVoice(doc)) {
        entry.aiVoice = true;
        if (comp.variantId) aiVoiceVariants.add(comp.variantId);
        else aiVoiceCampaign = true;
      }
    } else {
      // Every slide, in order (slide n is `${main.id}_${n}`; the first gap ends the set).
      const ids = Array.from({ length: 29 }, (_, k) => `${main!.id}_${k + 2}`);
      const found = new Map(((await ctx.ws.collection("mediaAssets").getMany(ids)) as MediaAsset[]).map((a) => [a.id, a]));
      const slides = [main];
      for (const id of ids) {
        const a = found.get(id);
        if (!a || a.status !== "ready") break;
        slides.push(a);
      }
      const kind = stillKindOf(doc, storyboard);
      stillKinds.add(kind);
      entry.still = kind;
      entry.slides = slides.length;
      const file = (k: number, s: MediaAsset) => `slide-${String(k + 1).padStart(2, "0")}.${extFor(s.mimeType, s.storagePath)}`;
      for (const [k, s] of slides.entries()) {
        const path =
          kind === "store_ios" || kind === "store_android"
            ? `${STORE_FOLDER[kind].dir}/${slug(comp.title)}/${file(k, s)}`
            : kind === "thumbnail"
              ? `thumbnails/${name}${slides.length > 1 ? `-${k + 1}` : ""}.${extFor(s.mimeType, s.storagePath)}`
              : kind === "carousel"
                ? `carousels/${name}/${file(k, s)}`
                : `images/${name}${slides.length > 1 ? `-${k + 1}` : ""}.${extFor(s.mimeType, s.storagePath)}`;
        add(path, await fetchAsset(s), 0);
        included.push(s.id);
      }
    }
    const refs = collectAssetRefs(doc);
    for (const a of (await ctx.ws.collection("mediaAssets").getMany(refs.assetIds)) as MediaAsset[]) sourceAssets.set(a.id, a);
    manifest.push(entry);
  }
  if (!included.length) {
    throw new AppError("VALIDATION_FAILED", `No final renders to export. Render these first: ${missing.join(", ")}`, { userMessage: "Render the final video(s) before exporting the package." });
  }

  await ctx.progress(70, "adding copy and instructions");
  let packs: CopyPack[] = [];
  if (includeCopy) {
    packs = (await ctx.ws.collection("copyPacks").list({ where: [["campaignId", "==", campaignId]], limit: 50 })).items;
    // [APP_LINK] → the campaign's tracked link for that channel (else its general campaign link), so
    // pasted copy carries a measurable link. Without one the placeholder stays and the README says so.
    const links = (await ctx.ws.collection("attributionLinks").list({ where: [["campaignId", "==", campaignId]], limit: 100 })).items;
    packs = fillPackLinks(packs, links, (slug) => trackedLinkUrl(p.cfg, slug));
    // Posts of a video with an AI (external TTS) voice say so in their copy.
    packs = packs.map((pack) => (aiVoiceCampaign || (pack.variantId ? aiVoiceVariants.has(pack.variantId) : aiVoiceVariants.size > 0) ? withAiVoiceCopy(pack) : pack));
    for (const pack of packs) {
      const lines = pack.items.map((it) => `## ${it.kind}\n${it.text}\n`).join("\n");
      const status = pack.validation ? (pack.validation.ok ? "Claims check: passed" : `Claims check: ${pack.validation.issues.length} issue(s) — review before posting`) : "Claims check: not run";
      files[`copy/${pack.channel}${pack.locale !== "en" ? `-${pack.locale}` : ""}.txt`] = [strToU8(`${status}\n\n${lines}`), { level: 6 }];
    }
    if (packs.length) files["copy/copy-packs.json"] = [strToU8(JSON.stringify(packs.map((x) => ({ channel: x.channel, locale: x.locale, items: x.items, validation: x.validation })), null, 2)), { level: 6 }];
  }

  const channels = [...new Set([...campaign.channels, ...packs.map((x) => x.channel)])];
  const readme = [
    `# ${app.name} — ${campaign.name}`,
    "",
    `Exported by MuseLaunch on ${new Date().toISOString().slice(0, 10)}. Nothing in this package has been posted anywhere.`,
    "",
    "## What's inside",
    "- videos/ — final MP4s (H.264), one per format",
    "- thumbnails/ — poster frames you can use as covers, and YouTube thumbnails (JPEG, under 2 MB)",
    "- captions/ — SRT subtitle files (from the script or transcript)",
    "- images/ — single posts (JPEG), if any",
    ...(stillKinds.has("carousel") ? ["- carousels/ — one folder per carousel, slides numbered in posting order (JPEG)"] : []),
    ...(stillKinds.has("store_ios") ? ["- app-store/ — App Store screenshot sets (PNG, no transparency); see app-store/README.txt"] : []),
    ...(stillKinds.has("store_android") ? ["- google-play/ — Google Play screenshot sets (PNG, no transparency); see google-play/README.txt"] : []),
    "- copy/ — captions, titles and descriptions per channel (with claim-check status). Links are the campaign's tracked links; a remaining [APP_LINK] means no tracked link exists yet: replace it with your link.",
    "- ATTRIBUTION.txt — where every piece of media came from and its licence",
    "",
    "## How to publish manually",
    ...(channels.length ? channels.map((c) => `- ${CHANNEL_SPECS[c] ?? `${c}: upload the matching aspect-ratio video and paste the copy for this channel.`}`) : ["- Upload the video that matches each platform's aspect ratio and paste the matching copy."]),
    ...(stillKinds.has("carousel") ? [`- ${CAROUSEL_NOTES}`] : []),
    ...(stillKinds.has("thumbnail") ? ["- YouTube: in YouTube Studio open the video > Details > Thumbnail > Upload file, and pick the JPEG in thumbnails/."] : []),
    ...(stillKinds.has("store_ios") || stillKinds.has("store_android") ? ["- Store screenshots: see the README.txt in each store's folder for where to upload them."] : []),
    ...(aiVoiceVariants.size || aiVoiceCampaign ? [`- A video here uses an AI voice: its copy already ends with "${AI_VOICE_CAPTION_LINE}". Keep it when you post.`] : []),
    "",
    "After posting, mark each post as \"manually posted\" in MuseLaunch (Calendar) and paste the post URL so results can be tracked.",
    ...(missing.length ? ["", "## Not included (no final render yet)", ...missing.map((m) => `- ${m}`)] : []),
    "",
  ].join("\n");
  files["README.md"] = [strToU8(readme), { level: 6 }];
  for (const k of ["store_ios", "store_android"] as const) if (stillKinds.has(k)) files[`${STORE_FOLDER[k].dir}/README.txt`] = [strToU8(`${STORE_FOLDER[k].readme}\n`), { level: 6 }];
  if (stillKinds.has("carousel")) files["carousels/README.txt"] = [strToU8(`${CAROUSEL_NOTES}\nPost them as one carousel with the caption from copy/.\n`), { level: 6 }];
  const attribution = [
    `Media used in ${campaign.name}`,
    "",
    ...[...sourceAssets.values()].map(licenseLine),
    "",
    "Video frames were rendered by MuseLaunch with HyperFrames (Apache-2.0). Font: Inter (SIL OFL 1.1). Animation: GSAP (GreenSock standard licence).",
    "",
  ].join("\n");
  files["ATTRIBUTION.txt"] = [strToU8(attribution), { level: 6 }];
  files["manifest.json"] = [strToU8(JSON.stringify({ app: app.name, campaign: campaign.name, campaignId, compositions: manifest, missing }, null, 2)), { level: 6 }];

  ctx.throwIfCancelled();
  await ctx.progress(85, "compressing");
  const zip = zipSync(files);
  const h = shortHash(`${campaignId}:${included.sort().join(",")}:${packs.map((x) => `${x.id}@${x.updatedAt}`).join(",")}:${includeCopy}`, 20);
  const storagePath = workspaceKey(wid, "exports", campaignId, `${slug(app.name)}-${slug(campaign.name)}-${h.slice(0, 8)}.zip`);
  const put = await p.storage.put(storagePath, zip, { contentType: "application/zip" });
  const { entity: asset } = await ctx.ws.collection("mediaAssets").createIfAbsent(
    {
      id: `ast_pkg_${h}`,
      appId,
      campaignId,
      kind: "archive",
      role: "package",
      origin: "render",
      storagePath,
      mimeType: "application/zip",
      bytes: put.bytes,
      sha256: put.sha256,
      status: "ready",
      title: `${campaign.name} — export package`.slice(0, 200),
      originalFilename: storagePath.split("/").pop(),
      labels: ["export"],
      isProductTruth: false,
      license: { type: "owned" },
    },
    { actor: ctx.actor },
  );
  return { refs: [{ entity: "mediaAssets", id: asset.id }], data: { assetId: asset.id, files: Object.keys(files), missing, bytes: put.bytes } };
}

/**
 * Replace [APP_LINK] in exported copy with the campaign's active tracked link for that channel, else
 * its general (channel-less) campaign link. Links made for one specific post are never reused.
 */
export function fillPackLinks(packs: CopyPack[], links: AttributionLink[], urlOf: (slug: string) => string): CopyPack[] {
  const usable = links.filter((l) => l.active && !l.scheduledPostId);
  return packs.map((pack) => {
    const link = usable.find((l) => l.channel === pack.channel) ?? usable.find((l) => !l.channel);
    const url = link ? urlOf(link.slug) : undefined;
    return { ...pack, items: pack.items.map((it) => ({ ...it, text: fillAppLink(it.text, url) })) };
  });
}
