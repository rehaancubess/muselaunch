import { Channel, CopyItemKind, type CopyPack } from "@muselaunch/contracts";
import { AppError, toAppError, type JobContext, type JobResult } from "@muselaunch/platform";
import { generateJson, untrusted } from "@muselaunch/providers";
import { z } from "zod";
import { validateClaims } from "./claims";
import { dnaSummary, loadAppContext, requireDna } from "./context";
import { retrieveMemory } from "./memory";
import { RunRecorder } from "./runs";
import { clip, hashId } from "./util";

type ChannelT = z.infer<typeof Channel>;
type Kind = z.infer<typeof CopyItemKind>;

/** Channel-native constraints (character limits per item kind) and guidance. */
export const CHANNEL_RULES: Partial<Record<ChannelT, { limits: Partial<Record<Kind, number>>; kinds: Kind[]; guide: string }>> = {
  instagram: { limits: { caption: 2200, hashtags: 600, first_comment: 2200, cta: 120 }, kinds: ["caption", "hashtags", "cta", "first_comment"], guide: "Reels caption: hook in the first line (≤125 chars visible), short paragraphs, 3-8 relevant hashtags (max 30)." },
  tiktok: { limits: { caption: 2200, hashtags: 300, cta: 120 }, kinds: ["caption", "hashtags", "cta"], guide: "Short, punchy caption that complements the video; 3-5 niche hashtags." },
  youtube: { limits: { title: 100, description: 5000, hashtags: 300, cta: 120 }, kinds: ["title", "description", "hashtags"], guide: "Shorts title ≤ 100 chars (aim for 60), description with a clear CTA and link placeholder [APP_LINK]." },
  x: { limits: { caption: 280, thread: 280, cta: 120 }, kinds: ["caption", "thread"], guide: "Single post ≤ 280 chars; optional thread items each ≤ 280 chars." },
  threads: { limits: { caption: 500 }, kinds: ["caption"], guide: "Conversational post ≤ 500 chars." },
  linkedin: { limits: { caption: 3000, first_comment: 1250 }, kinds: ["caption", "first_comment"], guide: "Founder-voice post, first 2 lines must hook (≈210 chars before 'see more'); link in first comment." },
  facebook: { limits: { caption: 2200, cta: 120 }, kinds: ["caption", "cta"], guide: "Friendly caption with a clear CTA." },
  reddit: { limits: { title: 300, description: 5000 }, kinds: ["title", "description"], guide: "Community-first: be transparent you are the maker, no hype, follow subreddit norms; never astroturf." },
  producthunt: {
    limits: { product_hunt_tagline: 60, product_hunt_description: 260, maker_comment: 1500, first_comment: 1500 },
    kinds: ["product_hunt_tagline", "product_hunt_description", "maker_comment"],
    guide: "Product Hunt: tagline ≤ 60 chars, description ≤ 260 chars, maker comment telling the honest story of why you built it and asking for feedback.",
  },
  hackernews: { limits: { title: 80, description: 2000 }, kinds: ["title", "description"], guide: "Show HN title ≤ 80 chars, plain technical tone, no marketing superlatives." },
  newsletter: { limits: { title: 120, description: 5000, cta: 120 }, kinds: ["title", "description", "cta"], guide: "Subject line + short body + CTA." },
  website: { limits: { title: 120, description: 2000, cta: 60 }, kinds: ["title", "description", "cta"], guide: "Landing hero headline, subheadline and button label." },
  app_store: { limits: { title: 30, description: 4000 }, kinds: ["title", "description"], guide: "App Store promotional text style; title ≤ 30 chars." },
  google_play: { limits: { title: 30, description: 4000 }, kinds: ["title", "description"], guide: "Short description style; title ≤ 30 chars." },
};

const CopyOutput = z.object({
  packs: z
    .array(
      z.object({
        channel: Channel,
        items: z.array(z.object({ kind: CopyItemKind, text: z.string().min(1).max(5000), claimIds: z.array(z.string()).max(10).default([]) })).min(1).max(12),
      }),
    )
    .min(1)
    .max(14),
});
type CopyOutput = z.infer<typeof CopyOutput>;

export function copyLimitProblems(packs: CopyOutput["packs"]): string[] {
  const out: string[] = [];
  for (const p of packs) {
    const rules = CHANNEL_RULES[p.channel];
    for (const it of p.items) {
      const max = rules?.limits[it.kind];
      if (max && it.text.length > max) out.push(`${p.channel} ${it.kind} is ${it.text.length} chars; limit ${max}.`);
    }
  }
  return out;
}

const INSTRUCTIONS = `You are Muse Spark acting as MuseLaunch's copywriter. Write channel-native publishing copy for an indie app's campaign.

Rules:
- Follow each channel's limits and conventions exactly (given below). Write natively for each channel, not one text pasted everywhere.
- Product claims must come from the verified claims list; reference their ids in claimIds. Never invent numbers, reviews, testimonials, awards, rankings or user counts. Do not use prohibited claims.
- Use [APP_LINK] where a link belongs; never invent URLs or discount codes.
- Match the brand voice and team memory. Be honest about being the maker where the community expects it (Reddit, Product Hunt, Hacker News).`;

export async function copyGenerateHandler(ctx: JobContext<"copy.generate">): Promise<JobResult> {
  const p = ctx.platform;
  const { appId, campaignId, variantId } = ctx.payload;
  const channels = [...new Set(ctx.payload.channels)].map((c) => Channel.safeParse(c));
  if (channels.some((c) => !c.success)) throw new AppError("BAD_REQUEST", `Unknown channel in ${ctx.payload.channels.join(", ")}`);
  const chans = channels.map((c) => c.data!) as ChannelT[];
  const ws = ctx.ws;
  const campaign = await ws.collection("campaigns").getOrThrow(campaignId);
  if (campaign.appId !== appId) throw new AppError("BAD_REQUEST", "Campaign does not belong to this app");
  const existing = await ws.collection("copyPacks").getMany(chans.map((c) => hashId("cpy", ctx.job.id, c)));
  if (existing.length === chans.length) return { refs: existing.map((x) => ({ entity: "copyPacks", id: x.id })), data: { alreadyGenerated: true } };

  const app = await loadAppContext(ws, appId);
  requireDna(app);
  const variant = variantId ? await ws.collection("campaignVariants").getOrThrow(variantId) : null;
  if (variant && variant.campaignId !== campaignId) throw new AppError("BAD_REQUEST", "Variant does not belong to this campaign");
  const brief = campaign.briefId ? await ws.collection("campaignBriefs").get(campaign.briefId) : null;
  const storyboard = variant?.storyboardId ? await ws.collection("storyboards").get(variant.storyboardId) : null;
  const rec = await RunRecorder.start(ctx, { id: hashId("run", ctx.job.id), kind: "copywriting", model: p.cfg.META_MODEL_SPARK, goal: `Copy for ${chans.join(", ")} — ${campaign.name}`, appId });
  try {
    const memory = await retrieveMemory(p, { workspaceId: ctx.workspaceId, appId, task: "copywriting", query: `${campaign.request ?? campaign.name} ${variant?.hook ?? ""}`, jobId: ctx.job.id, agentRunId: rec.id });
    const input = [
      `Campaign: ${campaign.name} (goal: ${campaign.goal})${campaign.request ? `\nFounder's request: ${clip(campaign.request, 2000)}` : ""}`,
      brief ? `Brief: angle ${brief.angle} · USP ${brief.usp} · CTA "${brief.cta}"` : "",
      variant ? `Concept: ${variant.title} (${variant.angleType}) · Hook: ${variant.hook} · Key message: ${variant.keyMessage}` : "",
      storyboard ? `Video scenes (text on screen): ${storyboard.scenes.map((s) => s.onScreenText).filter(Boolean).join(" / ")}` : "",
      memory.items.length ? `Team memory:\n${memory.summary}` : "",
      "Channels and rules:",
      ...chans.map((c) => {
        const r = CHANNEL_RULES[c];
        return `- ${c}: items ${(r?.kinds ?? ["caption"]).join(", ")}. Limits: ${Object.entries(r?.limits ?? { caption: 2200 }).map(([k, v]) => `${k} ≤ ${v}`).join(", ")}. ${r?.guide ?? ""}`;
      }),
      "",
      untrusted("app_dna", dnaSummary(app), 12_000),
    ]
      .filter(Boolean)
      .join("\n");
    await ctx.progress(20, "Muse Spark is writing copy");
    let out = await generateJson(p, { ctx: rec.callCtx("copy.generate"), model: "spark", instructions: INSTRUCTIONS, input, schema: CopyOutput, schemaName: "CopyPacks", maxOutputTokens: 8000, reasoningEffort: "low", cacheKey: "agents.copy" });
    await rec.modelStep("Write channel copy (Muse Spark)", out, chans);
    let packs = out.data.packs.filter((x) => chans.includes(x.channel));
    let limits = copyLimitProblems(packs);
    const missing = chans.filter((c) => !packs.some((x) => x.channel === c));
    if (limits.length || missing.length) {
      const issues = [...limits, ...missing.map((m) => `Missing pack for ${m}.`)];
      out = await generateJson(p, { ctx: rec.callCtx("copy.repair"), model: "spark", instructions: INSTRUCTIONS, input: `${input}\n\nFix these problems and return all packs again:\n${issues.map((x) => `- ${x}`).join("\n")}\n\nPrevious output:\n${JSON.stringify(out.data).slice(0, 15_000)}`, schema: CopyOutput, schemaName: "CopyPacks", maxOutputTokens: 8000, reasoningEffort: "low", cacheKey: "agents.copy" });
      await rec.modelStep("Repair copy limits (Muse Spark)", out, issues);
      packs = out.data.packs.filter((x) => chans.includes(x.channel));
      limits = copyLimitProblems(packs);
    }
    ctx.throwIfCancelled();
    await ctx.progress(70, "checking claims");
    const verified = new Set(app.verifiedClaims.map((c) => c.id));
    const created: CopyPack[] = [];
    for (const c of chans) {
      const pack = packs.find((x) => x.channel === c);
      if (!pack) continue;
      const items = pack.items.map((it, i) => ({ id: `${c}_${i + 1}`, kind: it.kind, text: it.text, claimIds: it.claimIds.filter((x) => verified.has(x)) }));
      const check = await validateClaims(p, { workspaceId: ctx.workspaceId, appId, jobId: ctx.job.id, agentRunId: rec.id, texts: items.map((it) => ({ id: it.id, text: it.text })) });
      const limitIssues = items.flatMap((it) => {
        const max = CHANNEL_RULES[c]?.limits[it.kind];
        return max && it.text.length > max ? [{ itemId: it.id, issue: `Exceeds the ${c} ${it.kind} limit (${it.text.length}/${max} characters)` }] : [];
      });
      const issues = [...check.issues.map((x) => ({ itemId: x.id, issue: x.issue })), ...limitIssues];
      const { entity } = await ws.collection("copyPacks").createIfAbsent(
        {
          id: hashId("cpy", ctx.job.id, c),
          appId,
          campaignId,
          variantId: variant?.id,
          channel: c,
          locale: app.app.targetLanguages[0] ?? "en",
          items,
          validation: { ok: issues.length === 0, issues, checkedAt: new Date().toISOString() },
          generatedByRunId: rec.id,
        },
        { actor: ctx.actor },
      );
      created.push(entity);
    }
    if (!created.length) throw new AppError("PROVIDER_ERROR", "No copy was produced for the requested channels", { retryable: true });
    await rec.step({ kind: "decision", title: `Claim validation: ${created.filter((x) => x.validation?.ok).length}/${created.length} packs clean`, output: created.map((x) => ({ channel: x.channel, issues: x.validation?.issues.length })) });
    await rec.finish("succeeded", { outputRefs: created.map((x) => ({ entity: "copyPacks", id: x.id })), memoryRefs: memory.items.map((m) => m.id) });
    return { refs: [...created.map((x) => ({ entity: "copyPacks", id: x.id })), { entity: "agentRuns", id: rec.id }], data: { channels: created.map((x) => x.channel), issues: created.reduce((n, x) => n + (x.validation?.issues.length ?? 0), 0) } };
  } catch (raw) {
    const err = toAppError(raw);
    await rec.finish(err.code === "CANCELLED" ? "cancelled" : "failed", { error: err.toInfo() }).catch(() => {});
    throw err;
  }
}
