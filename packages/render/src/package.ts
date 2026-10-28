/**
 * package.export: a ZIP the user can publish from by hand — final videos, posters, SRT captions,
 * static slides, copy packs, publishing instructions and an attribution/licence list.
 * Nothing is posted anywhere; this is the honest alternative while social OAuth is pending.
 */
import { zipSync, strToU8, type Zippable } from "fflate";
import { fillAppLink, type AttributionLink, type Composition, type CompositionDoc, type CopyPack, type MediaAsset } from "@muselaunch/contracts";
import { collectAssetRefs, docHash } from "@muselaunch/compositions";
import { getVersion } from "@muselaunch/compositions/store";
import { AppError, assertKeyInWorkspace, safeFilename, trackedLinkUrl, workspaceKey, type JobContext } from "@muselaunch/platform";
import { renderCacheKey } from "./keys";
import { extFor, shortHash, toSrt } from "./media";

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

  for (const [i, comp] of comps.entries()) {
    ctx.throwIfCancelled();
    await ctx.progress(5 + (i / comps.length) * 60, `packaging ${comp.title}`);
    const ver = await getVersion(ctx.ws, comp.id, comp.approvedVersion ?? comp.currentVersion);
    const doc: CompositionDoc = ver.doc;
    const isVideo = doc.kind === "video";
    const key = renderCacheKey(docHash(doc), "final", isVideo ? "mp4" : "png");
    const main = await ctx.ws.collection("mediaAssets").get(`ast_r_${key}`);
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
    } else {
      const slides = [main, ...((await ctx.ws.collection("mediaAssets").getMany(Array.from({ length: 30 }, (_, k) => `${main.id}_${k + 2}`))) as MediaAsset[])];
      for (const [k, s] of slides.entries()) {
        add(`images/${name}-${k + 1}.${extFor(s.mimeType, s.storagePath)}`, await fetchAsset(s), 0);
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
    "- thumbnails/ — poster frames you can use as covers",
    "- captions/ — SRT subtitle files (from the script or transcript)",
    "- images/ — static slides / ads, if any",
    "- copy/ — captions, titles and descriptions per channel (with claim-check status). Links are the campaign's tracked links; a remaining [APP_LINK] means no tracked link exists yet: replace it with your link.",
    "- ATTRIBUTION.txt — where every piece of media came from and its licence",
    "",
    "## How to publish manually",
    ...(channels.length ? channels.map((c) => `- ${CHANNEL_SPECS[c] ?? `${c}: upload the matching aspect-ratio video and paste the copy for this channel.`}`) : ["- Upload the video that matches each platform's aspect ratio and paste the matching copy."]),
    "",
    "After posting, mark each post as \"manually posted\" in MuseLaunch (Calendar) and paste the post URL so results can be tracked.",
    ...(missing.length ? ["", "## Not included (no final render yet)", ...missing.map((m) => `- ${m}`)] : []),
    "",
  ].join("\n");
  files["README.md"] = [strToU8(readme), { level: 6 }];
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
