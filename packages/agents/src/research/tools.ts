import { Channel, ContentType, FindingKind, SpecialistRole, type AgentPlan, type Competitor, type EntityRef, type SourceRef } from "@muselaunch/contracts";
import { AppError, type JobContext } from "@muselaunch/platform";
import { generateText, untrusted } from "@muselaunch/providers";
import { load } from "cheerio";
import { z } from "zod";
import type { AppContextData } from "../context";
import { fetcherFor } from "../fetcher";
import { extractPageText } from "../import/parsers";
import { defineTool, type LoopTool } from "../loop";
import type { RunRecorder } from "../runs";
import { canonicalUrl, clip, hashId, hostOf, isHttpUrl, mergeSources, normalizeText, nowIso, sha256, uniq } from "../util";

/** Every URL the run actually retrieved (search results, citations, fetched pages). Only these can back saved items. */
export class SourceRegistry {
  private readonly byUrl = new Map<string, { ref: SourceRef; text: string }>();

  register(ref: SourceRef, text = ""): void {
    const key = ref.url ? canonicalUrl(ref.url) : null;
    if (!key || !isHttpUrl(ref.url)) return;
    const prev = this.byUrl.get(key);
    if (prev) {
      prev.text = clip(`${prev.text}\n${text}`, 60_000);
      if (!prev.ref.excerpt && ref.excerpt) prev.ref = { ...prev.ref, excerpt: ref.excerpt };
      return;
    }
    this.byUrl.set(key, { ref: { ...ref, title: ref.title ? clip(ref.title, 500) : undefined, excerpt: ref.excerpt ? clip(ref.excerpt, 2000) : undefined }, text: clip(`${ref.title ?? ""}\n${ref.excerpt ?? ""}\n${text}`, 60_000) });
  }

  get(url: string) {
    const key = canonicalUrl(url);
    return key ? this.byUrl.get(key) : undefined;
  }

  has(url: string): boolean {
    return Boolean(this.get(url));
  }

  hosts(): Set<string> {
    return new Set([...this.byUrl.values()].map((v) => hostOf(v.ref.url!)));
  }

  /** Resolve cited URLs to SourceRefs; unknown URLs are reported, never trusted. */
  resolve(urls: string[]): { refs: SourceRef[]; unknown: string[] } {
    const refs: SourceRef[] = [];
    const unknown: string[] = [];
    for (const u of uniq(urls)) {
      const hit = this.get(u);
      if (hit) refs.push(hit.ref);
      else unknown.push(u);
    }
    return { refs, unknown };
  }

  size() {
    return this.byUrl.size;
  }
}

const Urls = (max: number) => z.array(z.string().max(2048)).min(1).max(max).describe("URLs returned by search_web or fetch_page in this run");
const Short = (n: number) => z.string().max(n);

export interface ResearchOutputs {
  findingIds: string[];
  refs: EntityRef[];
  plan?: AgentPlan;
  counts: Record<string, number>;
}

export interface ResearchToolOptions {
  ctx: JobContext;
  rec: RunRecorder;
  registry: SourceRegistry;
  app: AppContextData;
  runId?: string;
  country?: string;
  /** URLs fetch_page may open even if search did not return them (app/competitor/user-provided). */
  allowedUrls: string[];
  out: ResearchOutputs;
}

function corroboration(refs: SourceRef[]) {
  return Math.max(1, new Set(refs.map((r) => hostOf(r.url ?? ""))).size);
}

export function planTool(o: Pick<ResearchToolOptions, "out" | "rec">) {
  return defineTool({
    name: "set_plan",
    description: "Record your plan: goal, hypotheses and 2-6 bounded subtasks (call once at the start; may be called again to revise).",
    schema: z.object({
      goal: Short(2000),
      audience: Short(1000).optional(),
      hypotheses: z.array(Short(500)).max(6).default([]),
      tasks: z.array(z.object({ title: Short(200), role: SpecialistRole, objective: Short(2000) })).min(1).max(6),
    }),
    async run(a) {
      const plan: AgentPlan = {
        goal: a.goal,
        audience: a.audience,
        hypotheses: a.hypotheses,
        deliverables: [],
        measurement: [],
        tasks: a.tasks.map((t, i) => ({ id: `task_${i + 1}`, role: t.role, title: t.title, objective: t.objective, dependsOn: [], status: "pending" as const })),
      };
      o.out.plan = plan;
      await o.rec.save({ plan });
      return { output: { ok: true, taskIds: plan.tasks.map((t) => t.id) } };
    },
  });
}

export function searchTool(o: ResearchToolOptions): LoopTool {
  return defineTool({
    name: "search_web",
    description: "Live web search via Muse Spark with search grounding. Returns concise notes and the source URLs (with cited excerpts). Each call uses one search from the budget.",
    search: true,
    schema: z.object({ query: z.string().min(3).max(300), purpose: Short(300).optional() }),
    async run(a) {
      const res = await generateText(o.ctx.platform, {
        ctx: o.rec.callCtx("research.search"),
        model: "spark",
        instructions:
          "You are a meticulous web researcher supporting app marketing. Search the web and answer with at most 10 short factual bullet points. Every bullet must come from a source you cite. Prefer sources from the last 12 months. Do not speculate, estimate or fill gaps; say 'no reliable sources found' if so.",
        input: `Query: ${a.query}\n${a.purpose ? `Purpose: ${a.purpose}\n` : ""}Context — the app being marketed: ${clip(o.app.dna?.oneLiner ?? o.app.app.name, 300)}`,
        webSearch: { contextSize: "medium", country: o.country },
        maxOutputTokens: 2500,
        reasoningEffort: "low",
      });
      // The search budget counts search_web calls, one each: Muse Spark runs several web searches inside
      // one call (5–10 in the first live run), which would otherwise exhaust a 12-search budget in two
      // calls. Their cost is still metered in costUsd.
      o.rec.addModelUsage({ ...res, searchCalls: 0 });
      o.rec.usage.searchCalls += 1;
      for (const c of res.citations) o.registry.register(c);
      for (const r of res.searchResults) o.registry.register(r);
      const sources = mergeSources(res.citations, res.searchResults, 12).map((s) => ({ url: s.url, title: s.title, excerpt: clip(s.excerpt, 400) }));
      return {
        output: { query: a.query, notes: untrusted("search_web notes (Muse Spark summary of web sources)", clip(res.text, 5000), 6000), sources },
        citations: mergeSources(res.citations, res.searchResults, 20),
      };
    },
  });
}

export function fetchTool(o: ResearchToolOptions): LoopTool {
  const allowed = new Set(o.allowedUrls.map((u) => canonicalUrl(u)).filter(Boolean) as string[]);
  const allowedHosts = new Set(o.allowedUrls.map(hostOf));
  return defineTool({
    name: "fetch_page",
    description: "Fetch the readable text of a public page. Only URLs returned by search_web in this run, or the app/competitor/user-provided URLs listed in the brief.",
    schema: z.object({ url: z.string().max(2048) }),
    async run(a) {
      const key = canonicalUrl(a.url);
      if (!key || !isHttpUrl(a.url)) throw new AppError("BAD_REQUEST", "Invalid URL");
      if (!o.registry.has(a.url) && !allowed.has(key) && !allowedHosts.has(hostOf(a.url))) {
        throw new AppError("FORBIDDEN", "fetch_page only opens URLs returned by search_web or listed as allowed in the brief");
      }
      const res = await fetcherFor(o.ctx.platform)(a.url, { accept: ["text/html", "application/xhtml", "text/plain"], maxBytes: 3 * 1024 * 1024, timeoutMs: 20_000, signal: o.ctx.signal });
      if (res.status !== 200) throw new AppError("PROVIDER_UNAVAILABLE", `Page returned ${res.status}`, { retryable: false });
      const $ = load(res.text());
      const title = ($("title").first().text().trim() || $('meta[property="og:title"]').attr("content")) ?? undefined;
      const text = res.contentType.startsWith("text/plain") ? clip(res.text(), 8000) : extractPageText($, 8000);
      const ref: SourceRef = { kind: "url", url: res.url, title: title ? clip(title, 500) : undefined, retrievedAt: nowIso(), excerpt: clip(text, 300), contentHash: sha256(res.body) };
      o.registry.register(ref, text);
      if (canonicalUrl(res.url) !== key) o.registry.register({ ...ref, url: a.url }, text);
      return { output: { url: res.url, title, text: untrusted(res.url, text, 8000) }, citations: [ref] };
    },
  });
}

function cite(o: ResearchToolOptions, urls: string[]): SourceRef[] {
  const { refs, unknown } = o.registry.resolve(urls);
  if (!refs.length) {
    throw new AppError("VALIDATION_FAILED", `None of the sourceUrls were retrieved in this run (${unknown.slice(0, 3).join(", ")}). Cite URLs returned by search_web or fetch_page.`);
  }
  return refs;
}

export function saveFindingTool(o: ResearchToolOptions): LoopTool {
  return defineTool({
    name: "save_finding",
    description: "Save one research finding. statement = what the cited sources say; interpretation = what it may mean for this app (clearly an interpretation).",
    schema: z.object({
      kind: FindingKind,
      statement: z.string().min(1).max(1500),
      interpretation: Short(1500).optional(),
      sourceUrls: Urls(6),
      confidence: z.number().min(0).max(1),
      channels: z.array(Channel).max(8).default([]),
      tags: z.array(Short(40)).max(8).default([]),
      speculative: z.boolean().default(false).describe("true if the statement goes beyond what sources directly say"),
    }),
    async run(a) {
      const evidence = cite(o, a.sourceUrls);
      const dedupKey = sha256(normalizeText(a.statement)).slice(0, 40);
      const id = hashId("fnd", o.app.app.id, dedupKey);
      const repo = o.ctx.ws.collection("researchFindings");
      const existing = await repo.get(id);
      const tags = uniq([...a.tags, ...(a.speculative ? ["speculative", "needs_review"] : [])]).slice(0, 20);
      if (existing) {
        const merged = mergeSources(existing.evidence, evidence);
        await repo.update(id, { evidence: merged, corroboration: corroboration(merged), observedAt: nowIso(), confidence: Math.max(existing.confidence, a.confidence), tags: uniq([...existing.tags, ...tags]).slice(0, 20) }, { actor: o.ctx.actor });
      } else {
        await repo.create(
          {
            id,
            appId: o.app.app.id,
            runId: o.runId ?? o.rec.id,
            kind: a.kind,
            statement: a.statement,
            interpretation: a.interpretation,
            evidence,
            confidence: a.speculative ? Math.min(a.confidence, 0.5) : a.confidence,
            corroboration: corroboration(evidence),
            channels: a.channels,
            tags,
            observedAt: nowIso(),
            dedupKey,
          },
          { actor: o.ctx.actor },
        );
      }
      if (!o.out.findingIds.includes(id)) {
        o.out.findingIds.push(id);
        o.out.refs.push({ entity: "researchFindings", id });
      }
      o.out.counts.findings = (o.out.counts.findings ?? 0) + 1;
      return { output: { findingId: id, deduplicated: Boolean(existing), sources: evidence.length } };
    },
  });
}

export function saveOpportunityTool(o: ResearchToolOptions): LoopTool {
  return defineTool({
    name: "save_opportunity",
    description: "Save a marketing opportunity for this app, grounded in saved findings and cited sources.",
    schema: z.object({
      title: z.string().min(1).max(200),
      topic: Short(300),
      audience: Short(300),
      whyRelevant: Short(1500).describe("Connect the evidence to this app's real features/audiences"),
      proposedAngle: Short(1000),
      confidence: z.number().min(0).max(1),
      score: z.number().min(0).max(100),
      effort: z.enum(["low", "medium", "high"]),
      contentType: ContentType,
      channels: z.array(Channel).max(8).default([]),
      geography: z.array(z.string().length(2)).max(10).default([]),
      sourceUrls: Urls(6),
      findingIds: z.array(z.string()).max(10).default([]),
    }),
    async run(a) {
      const evidence = cite(o, a.sourceUrls);
      const findingIds = a.findingIds.filter((f) => o.out.findingIds.includes(f));
      const id = hashId("opp", o.app.app.id, normalizeText(a.title));
      const repo = o.ctx.ws.collection("opportunities");
      const existing = await repo.get(id);
      const doc = {
        appId: o.app.app.id,
        title: a.title,
        topic: a.topic,
        audience: a.audience,
        whyRelevant: a.whyRelevant,
        proposedAngle: a.proposedAngle,
        confidence: a.confidence,
        evidence: existing ? mergeSources(existing.evidence, evidence) : evidence,
        findingIds: uniq([...(existing?.findingIds ?? []), ...findingIds]),
        channels: a.channels,
        contentType: a.contentType,
        effort: a.effort,
        geography: a.geography.map((g) => g.toUpperCase()),
        observedAt: nowIso(),
        score: a.score,
        runId: o.runId,
      };
      if (existing) await repo.update(id, { ...doc, status: existing.status }, { actor: o.ctx.actor });
      else await repo.create({ id, ...doc, status: "new" }, { actor: o.ctx.actor });
      o.out.refs.push({ entity: "opportunities", id });
      o.out.counts.opportunities = (o.out.counts.opportunities ?? 0) + 1;
      return { output: { opportunityId: id } };
    },
  });
}

export function saveCompetitorTool(o: ResearchToolOptions): LoopTool {
  return defineTool({
    name: "save_competitor_observation",
    description: "Record how a competitor markets itself (positioning, hooks, formats) and a comparison with THIS app's real features. No invented competitor metrics.",
    schema: z.object({
      name: z.string().min(1).max(120),
      websiteUrl: z.string().max(2048).optional(),
      appStoreUrl: z.string().max(2048).optional(),
      playStoreUrl: z.string().max(2048).optional(),
      positioning: Short(1000).optional(),
      observedHooks: z.array(Short(300)).max(8).default([]),
      observedFormats: z.array(Short(120)).max(8).default([]),
      comparison: z.array(z.object({ topic: Short(120), them: Short(400), us: Short(400) })).max(6).default([]),
      sourceUrls: Urls(6),
    }),
    async run(a) {
      const sources = cite(o, a.sourceUrls);
      const hosts = o.registry.hosts();
      // Only keep competitor URLs whose host we actually saw in this run (no guessed domains).
      const seenUrl = (u?: string) => (u && isHttpUrl(u) && (o.registry.has(u) || hosts.has(hostOf(u))) ? u : undefined);
      const repo = o.ctx.ws.collection("competitors");
      const existing = o.app.competitors.find((c) => normalizeText(c.name) === normalizeText(a.name));
      const comparison: Competitor["comparison"] = a.comparison.map((c) => ({ ...c, evidence: sources.slice(0, 3) }));
      let id: string;
      if (existing) {
        const updated = await repo.update(
          existing.id,
          {
            positioning: existing.origin === "user" && existing.positioning ? existing.positioning : (a.positioning ?? existing.positioning),
            websiteUrl: existing.websiteUrl ?? seenUrl(a.websiteUrl),
            storeUrls: { ios: existing.storeUrls.ios ?? seenUrl(a.appStoreUrl), android: existing.storeUrls.android ?? seenUrl(a.playStoreUrl) },
            observedHooks: uniq([...existing.observedHooks, ...a.observedHooks]).slice(0, 30),
            observedFormats: uniq([...existing.observedFormats, ...a.observedFormats]).slice(0, 30),
            comparison: [...existing.comparison.filter((c) => !comparison.some((n) => normalizeText(n.topic) === normalizeText(c.topic))), ...comparison].slice(0, 20),
            sources: mergeSources(existing.sources, sources, 40),
            lastResearchedAt: nowIso(),
          },
          { actor: o.ctx.actor },
        );
        id = updated.id;
        o.app.competitors = o.app.competitors.map((c) => (c.id === id ? updated : c));
      } else {
        const created = await repo.create(
          {
            id: hashId("cpt", o.app.app.id, normalizeText(a.name)),
            appId: o.app.app.id,
            name: a.name,
            websiteUrl: seenUrl(a.websiteUrl),
            storeUrls: { ios: seenUrl(a.appStoreUrl), android: seenUrl(a.playStoreUrl) },
            positioning: a.positioning,
            observedHooks: a.observedHooks,
            observedFormats: a.observedFormats,
            comparison,
            sources,
            origin: "research",
            lastResearchedAt: nowIso(),
          },
          { actor: o.ctx.actor },
        );
        id = created.id;
        o.app.competitors.push(created);
      }
      o.out.refs.push({ entity: "competitors", id });
      o.out.counts.competitors = (o.out.counts.competitors ?? 0) + 1;
      return { output: { competitorId: id } };
    },
  });
}

export function saveAudienceTool(o: ResearchToolOptions): LoopTool {
  return defineTool({
    name: "save_audience_segment",
    description: "Save an audience segment evidenced by sources (where they gather, what they struggle with).",
    schema: z.object({
      name: z.string().min(1).max(120),
      description: Short(1500),
      painPoints: z.array(Short(300)).max(8).default([]),
      motivations: z.array(Short(300)).max(8).default([]),
      channels: z.array(Channel).max(8).default([]),
      communities: z.array(z.object({ name: Short(160), url: z.string().max(2048).optional(), channel: Channel })).max(8).default([]),
      sourceUrls: Urls(6),
    }),
    async run(a) {
      const evidence = cite(o, a.sourceUrls);
      const id = hashId("asg", o.app.app.id, "research", normalizeText(a.name));
      const repo = o.ctx.ws.collection("audienceSegments");
      const communities = a.communities.map((c) => ({ name: c.name, channel: c.channel, url: c.url && o.registry.has(c.url) ? c.url : undefined }));
      const existing = await repo.get(id);
      if (existing) await repo.update(id, { description: a.description, painPoints: a.painPoints, motivations: a.motivations, channels: a.channels, communities, evidence: mergeSources(existing.evidence, evidence) }, { actor: o.ctx.actor });
      else await repo.create({ id, appId: o.app.app.id, name: a.name, description: a.description, painPoints: a.painPoints, motivations: a.motivations, channels: a.channels, communities, evidence, origin: "research" }, { actor: o.ctx.actor });
      o.out.refs.push({ entity: "audienceSegments", id });
      o.out.counts.audienceSegments = (o.out.counts.audienceSegments ?? 0) + 1;
      return { output: { segmentId: id } };
    },
  });
}

export function saveProspectTool(o: ResearchToolOptions): LoopTool {
  return defineTool({
    name: "save_creator_prospect",
    description:
      "Suggest a creator/community to collaborate with, from public evidence only. The handle must appear in a cited source. Public contacts are kept only if they literally appear on the cited page (never guess emails).",
    schema: z.object({
      channel: Channel,
      handle: z.string().min(1).max(120),
      url: z.string().max(2048).optional(),
      displayName: Short(160).optional(),
      niche: Short(300),
      relevanceScore: z.number().min(0).max(100),
      relevanceReasons: z.array(Short(400)).max(5).default([]),
      sourceUrls: Urls(4),
      publicContacts: z.array(z.object({ kind: z.enum(["email", "contact_form", "dm", "website", "business_inquiry"]), value: Short(300), sourceUrl: z.string().max(2048) })).max(3).default([]),
    }),
    async run(a) {
      const evidence = cite(o, a.sourceUrls);
      const handle = a.handle.replace(/^@/, "");
      const seenText = evidence.map((e) => `${e.url} ${o.registry.get(e.url!)?.text ?? ""}`).join("\n").toLowerCase();
      if (!seenText.includes(handle.toLowerCase())) {
        throw new AppError("VALIDATION_FAILED", `The handle "${a.handle}" does not appear in the cited sources; only suggest creators you actually found.`);
      }
      const dropped: string[] = [];
      const contacts = a.publicContacts.flatMap((c) => {
        const src = o.registry.get(c.sourceUrl);
        const ok = src && src.text.toLowerCase().includes(c.value.toLowerCase()) && (c.kind !== "email" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.value));
        if (!ok) {
          dropped.push(c.value);
          return [];
        }
        return [{ kind: c.kind, value: c.value, source: src.ref, verified: false }];
      });
      const id = hashId("prs", o.app.app.id, a.channel, handle.toLowerCase());
      const repo = o.ctx.ws.collection("outreachProspects");
      const existing = await repo.get(id);
      const doc = {
        appId: o.app.app.id,
        channel: a.channel,
        handle: a.handle,
        url: a.url && o.registry.has(a.url) ? a.url : undefined,
        displayName: a.displayName,
        niche: a.niche,
        relevanceScore: a.relevanceScore,
        relevanceReasons: a.relevanceReasons,
        evidence: existing ? mergeSources(existing.evidence, evidence) : evidence,
        publicContacts: contacts,
        runId: o.runId,
      };
      if (existing) await repo.update(id, { ...doc, status: existing.status, notes: existing.notes }, { actor: o.ctx.actor });
      else await repo.create({ id, ...doc, status: "suggested" }, { actor: o.ctx.actor });
      o.out.refs.push({ entity: "outreachProspects", id });
      o.out.counts.prospects = (o.out.counts.prospects ?? 0) + 1;
      return { output: { prospectId: id, droppedUnverifiedContacts: dropped } };
    },
  });
}

export function finishTool() {
  return defineTool({
    name: "finish",
    description: "End the run with a short summary of what was found (2-4 sentences).",
    schema: z.object({ summary: z.string().min(1).max(2000) }),
    async run(a) {
      return { output: { ok: true, summary: a.summary }, finish: true };
    },
  });
}
