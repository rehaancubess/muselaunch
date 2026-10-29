import type {
  AttributionLevel,
  AttributionLink,
  Channel,
  ConnectedAccount,
  CostOutcome,
  FunnelStep,
  InsightMetric,
  InsightsOverview,
  InsightsQuery,
  MetricName,
  MetricObservation,
  MetricSource,
  MetricSourceValue,
  MissingMetric,
} from "@muselaunch/contracts";
import { nowIso, type WorkspaceDb } from "@muselaunch/db";
import { AppError, type Platform } from "@muselaunch/platform";
import { ATTRIBUTION_STRENGTH, CLICK_DEFINITION, FUNNEL_METRICS, METRIC_INFO, OVERVIEW_METRICS, SOURCE_PRIORITY, sourceLabel, weakestAttribution, type MetricKind } from "./metrics";
import { DAY_MS, scopeOf } from "./observations";

// ---------------------------------------------------------------------------
// Range handling
// ---------------------------------------------------------------------------

export interface Range {
  from: number;
  to: number;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** `from`/`to` accept YYYY-MM-DD (whole UTC days, `to` inclusive) or ISO datetimes. Default: the last 28 UTC days incl. today. */
export function resolveRange(q: Pick<InsightsQuery, "from" | "to">, now = Date.now()): Range {
  const parse = (s: string, end: boolean) => {
    const ms = DATE_ONLY.test(s) ? Date.parse(`${s}T00:00:00Z`) + (end ? DAY_MS : 0) : Date.parse(s);
    if (!Number.isFinite(ms)) throw new AppError("BAD_REQUEST", `Invalid date ${s}`);
    return ms;
  };
  // Default: the last 28 UTC days including today (today's partial day counts as measured so far).
  const to = q.to ? parse(q.to, true) : Math.floor(now / DAY_MS) * DAY_MS + DAY_MS;
  const from = q.from ? parse(q.from, false) : to - 28 * DAY_MS;
  if (!(from < to)) throw new AppError("BAD_REQUEST", "`from` must be before `to`");
  if (to - from > 400 * DAY_MS) throw new AppError("BAD_REQUEST", "Range can be at most 400 days");
  return { from, to };
}

/** Load the app's observations whose window starts inside [from, to). */
export async function loadObservations(ws: WorkspaceDb, appId: string, from: number, to: number, cap = 20_000): Promise<{ items: MetricObservation[]; truncated: boolean }> {
  const items: MetricObservation[] = [];
  let cursor: string | null = null;
  do {
    const page = await ws.collection("metricObservations").list({
      where: [
        ["appId", "==", appId],
        ["windowStart", ">=", new Date(from).toISOString()],
        ["windowStart", "<", new Date(to).toISOString()],
      ],
      orderBy: { field: "windowStart", dir: "desc" },
      limit: 500,
      cursor,
    });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < cap);
  return { items, truncated: Boolean(cursor) };
}

// ---------------------------------------------------------------------------
// Aggregation (pure)
// ---------------------------------------------------------------------------

export interface Filters {
  channel?: Channel;
  campaignId?: string;
}

interface Selection {
  /** value per currency ("" for non-currency metrics) */
  values: Map<string, number>;
  used: MetricObservation[];
  coveredMs: number;
}

const ms = (iso: string) => Date.parse(iso);

function inRange(o: MetricObservation, r: Range, kind: MetricKind): boolean {
  const s = ms(o.windowStart);
  const e = ms(o.windowEnd);
  if (kind === "stock") return e >= r.from && e <= r.to;
  return s >= r.from && e <= r.to;
}

/** Greedy non-overlapping selection within one scope, preferring finer windows then fresher data. */
function selectNonOverlapping(obs: MetricObservation[]): MetricObservation[] {
  const sorted = [...obs].sort((a, b) => ms(a.windowEnd) - ms(a.windowStart) - (ms(b.windowEnd) - ms(b.windowStart)) || ms(b.provenance.fetchedAt) - ms(a.provenance.fetchedAt));
  const chosen: MetricObservation[] = [];
  for (const o of sorted) {
    const s = ms(o.windowStart);
    const e = ms(o.windowEnd);
    if (chosen.some((c) => s < ms(c.windowEnd) && ms(c.windowStart) < e)) continue;
    chosen.push(o);
  }
  return chosen;
}

function unionMs(windows: [number, number][], r: Range): number {
  const clipped = windows.map(([s, e]) => [Math.max(s, r.from), Math.min(e, r.to)] as [number, number]).filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const w of clipped) {
    if (!cur || w[0] > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [w[0], w[1]];
    } else cur[1] = Math.max(cur[1], w[1]);
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

function selectForSource(obs: MetricObservation[], metric: MetricName, r: Range, notes: Set<string>): Selection {
  const kind = METRIC_INFO[metric].kind;
  // Account-level numbers supersede campaign-level subsets from the same source (never add both).
  let pool = obs;
  const hasAggregate = obs.some((o) => !o.campaignId && !o.publicationId);
  if (hasAggregate && obs.some((o) => o.campaignId || o.publicationId) && obs[0]!.source !== "tracked_link") {
    pool = obs.filter((o) => !o.campaignId && !o.publicationId);
    notes.add("Account-level numbers are used; campaign-level numbers from the same source are subsets and are not added on top.");
  }
  const values = new Map<string, number>();
  const used: MetricObservation[] = [];
  const byScope = new Map<string, MetricObservation[]>();
  for (const o of pool) byScope.set(scopeOf(o), [...(byScope.get(scopeOf(o)) ?? []), o]);
  for (const group of byScope.values()) {
    let picked: MetricObservation[];
    if (kind === "flow") picked = selectNonOverlapping(group);
    else if (kind === "stock" || kind === "average") picked = [group.reduce((a, b) => (ms(b.windowEnd) > ms(a.windowEnd) ? b : a))];
    else {
      picked = [group.reduce((a, b) => (ms(b.windowEnd) - ms(b.windowStart) > ms(a.windowEnd) - ms(a.windowStart) ? b : a))];
      if (group.length > 1) notes.add(`${METRIC_INFO[metric].label} counts unique people and can't be added across periods; the widest single reported window is shown.`);
    }
    for (const o of picked) {
      const cur = o.currency ?? "";
      values.set(cur, (values.get(cur) ?? 0) + o.value);
      used.push(o);
    }
  }
  const coveredMs = kind === "flow" ? unionMs(used.map((o) => [ms(o.windowStart), ms(o.windowEnd)]), r) : 0;
  return { values, used, coveredMs };
}

export interface MetricComputation {
  metric: InsightMetric;
  /** observations considered (all sources) for downstream explanations */
  candidates: MetricObservation[];
}

/** Compute one metric for a range with explicit provenance; never fills gaps. */
export function computeMetric(metric: MetricName, all: MetricObservation[], r: Range, filters: Filters): Omit<InsightMetric, "comparison"> & { comparison: null } {
  const info = METRIC_INFO[metric];
  const notes = new Set<string>();
  let obs = all.filter((o) => o.metric === metric && inRange(o, r, info.kind));
  if (filters.channel) obs = obs.filter((o) => o.channel === filters.channel);
  if (filters.campaignId) obs = obs.filter((o) => o.campaignId === filters.campaignId);

  // channel group → source → selection
  const byChannel = new Map<string, Map<MetricSource, MetricObservation[]>>();
  for (const o of obs) {
    const ch = o.channel ?? "*";
    const m = byChannel.get(ch) ?? new Map<MetricSource, MetricObservation[]>();
    m.set(o.source, [...(m.get(o.source) ?? []), o]);
    byChannel.set(ch, m);
  }
  const perSource = new Map<MetricSource, { values: Map<string, number>; used: MetricObservation[] }>();
  const chosenPerChannel = new Map<string, Selection>();
  for (const [ch, sources] of byChannel) {
    let best: { source: MetricSource; sel: Selection } | null = null;
    for (const [source, list] of sources) {
      const sel = selectForSource(list, metric, r, notes);
      const agg: { values: Map<string, number>; used: MetricObservation[] } = perSource.get(source) ?? { values: new Map<string, number>(), used: [] };
      for (const [cur, v] of sel.values) agg.values.set(cur, (agg.values.get(cur) ?? 0) + v);
      agg.used.push(...sel.used);
      perSource.set(source, agg);
      if (!best || SOURCE_PRIORITY[source] < SOURCE_PRIORITY[best.source] || (SOURCE_PRIORITY[source] === SOURCE_PRIORITY[best.source] && sel.coveredMs > best.sel.coveredMs)) best = { source, sel };
    }
    if (best) {
      chosenPerChannel.set(ch, best.sel);
      if (sources.size > 1) notes.add(`${ch === "*" ? "Account-wide" : ch}: several sources report ${info.label.toLowerCase()}; the most direct one is used and the others are listed separately (not added).`);
    }
  }

  let contributing: Selection[] = [];
  if (chosenPerChannel.has("*")) {
    contributing = [chosenPerChannel.get("*")!];
    if (chosenPerChannel.size > 1) notes.add("Account-wide numbers are shown; per-channel numbers are listed by source but not added on top.");
  } else contributing = [...chosenPerChannel.values()];

  const totals = new Map<string, number>();
  const used: MetricObservation[] = [];
  for (const sel of contributing) {
    for (const [cur, v] of sel.values) totals.set(cur, (totals.get(cur) ?? 0) + v);
    used.push(...sel.used);
  }

  let value: number | null = null;
  let currency: string | undefined;
  let byCurrency: { currency: string; value: number }[] | undefined;
  if (info.kind === "average" && used.length > 1) {
    // Averages of different posts can't be added (or averaged without each post's view counts).
    notes.add(`${info.label} is reported per post; ${used.length} posts are in this range, so no single number is shown. Filter to one campaign or see each post's numbers.`);
  } else if (totals.size === 1) {
    const [[cur, v]] = [...totals.entries()] as [[string, number]];
    value = round(v);
    currency = cur || undefined;
  } else if (totals.size > 1) {
    byCurrency = [...totals.entries()].map(([c, v]) => ({ currency: c || "?", value: round(v) }));
    notes.add("Reported in several currencies; MuseLaunch doesn't convert currencies, so no single total is shown.");
  }

  const sources: MetricSourceValue[] = [...perSource.entries()]
    .sort((a, b) => SOURCE_PRIORITY[a[0]] - SOURCE_PRIORITY[b[0]])
    .map(([source, agg]) => {
      const first = agg.used[0]!;
      const vals = [...agg.values.entries()];
      return {
        source,
        label: sourceLabel(first),
        imported: agg.used.some((o) => o.provenance.imported),
        attribution: weakestAttribution(agg.used.map((o) => o.attribution)) ?? "none",
        value: vals.length === 1 ? round(vals[0]![1]) : null,
        currency: vals.length === 1 ? vals[0]![0] || undefined : undefined,
        observationCount: agg.used.length,
        definitions: [...new Set(agg.used.map((o) => o.metricDefinition))].slice(0, 5),
        lastFetchedAt: agg.used.map((o) => o.provenance.fetchedAt).sort().at(-1),
      };
    });

  const coveredMs = info.kind === "flow" ? unionMs(used.map((o) => [ms(o.windowStart), ms(o.windowEnd)]), r) : 0;
  const daysInRange = Math.round((r.to - r.from) / DAY_MS);
  const coverage = info.kind === "flow" && used.length ? { daysWithData: Math.round(coveredMs / DAY_MS), daysInRange } : null;
  if (coverage && coverage.daysWithData < coverage.daysInRange) notes.add(`Data covers ${coverage.daysWithData} of ${coverage.daysInRange} days in this range; the total only includes those days.`);
  if (info.kind === "stock" && used.length) notes.add(`Latest snapshot (${used.map((o) => o.windowEnd.slice(0, 16).replace("T", " ")).sort().at(-1)} UTC).`);

  const defs = [...new Set(used.map((o) => o.metricDefinition))];
  return {
    metric,
    label: info.label,
    unit: info.unit,
    currency,
    value,
    aggregation: used.length ? (info.kind === "flow" ? "sum" : info.kind === "average" && used.length > 1 ? "none" : "latest") : "none",
    sources,
    attribution: weakestAttribution(used.map((o) => o.attribution)),
    imported: used.some((o) => o.provenance.imported),
    definition: defs.length ? defs.slice(0, 3).join(" / ").slice(0, 1000) : "",
    window: used.length ? { start: new Date(Math.min(...used.map((o) => ms(o.windowStart)))).toISOString(), end: new Date(Math.max(...used.map((o) => ms(o.windowEnd)))).toISOString() } : null,
    coverage,
    observationIds: used.map((o) => o.id).slice(0, 100),
    comparison: null,
    byCurrency,
    notes: [...notes],
  };
}

const round = (n: number) => Math.round(n * 100) / 100;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export interface InsightsContext {
  connections: ConnectedAccount[];
  links: AttributionLink[];
  publicationsCount: number;
}

export async function loadContext(ws: WorkspaceDb, appId: string): Promise<InsightsContext> {
  const [accounts, links, pubs] = await Promise.all([
    ws.collection("connectedAccounts").list({ limit: 200 }),
    ws.collection("attributionLinks").list({ where: [["appId", "==", appId]], limit: 500 }),
    ws.collection("publications").list({ where: [["appId", "==", appId]], limit: 1 }),
  ]);
  return {
    connections: accounts.items.filter((a) => !a.appId || a.appId === appId),
    links: links.items,
    publicationsCount: pubs.items.length,
  };
}

const MONEY_FROM_REVENUECAT: MetricName[] = ["revenue", "trials_started", "new_subscriptions", "active_subscriptions", "mrr", "active_trials"];

export function explainMissing(metric: MetricName, ctx: InsightsContext, filters: Filters): MissingMetric {
  const label = METRIC_INFO[metric].label;
  const rc = ctx.connections.find((c) => c.provider === "revenuecat" && c.purposes.includes("analytics") && c.status !== "revoked");
  const m = (reason: string, action: MissingMetric["action"]): MissingMetric => ({ metric, label, reason, action });
  if (MONEY_FROM_REVENUECAT.includes(metric)) {
    if (filters.campaignId) return m(`No campaign-attributed ${label.toLowerCase()}. RevenueCat and store numbers are account-wide, so they can't be credited to one campaign.`, "none");
    if (filters.channel) return m(`${label} isn't broken down by channel: subscription and revenue data is account-wide.`, "none");
    if (!rc) return m(`Connect RevenueCat (or import a CSV) to see ${label.toLowerCase()}.`, "connect_revenuecat");
    if (rc.status === "error") return m(`RevenueCat connection has a problem: ${rc.lastError ?? "unknown error"}`, "connect_revenuecat");
    if (!rc.lastSyncAt) return m("RevenueCat is connected but hasn't synced yet.", "sync_now");
    return m(`RevenueCat reported no ${label.toLowerCase()} for this range (last sync ${rc.lastSyncAt.slice(0, 16).replace("T", " ")} UTC).`, "widen_range");
  }
  switch (metric) {
    case "installs":
      if (filters.campaignId) return m("Store installs aren't attributed to campaigns. Use tracked links (clicks) or a store campaign report import.", "import_csv");
      return m("Installs need an App Store Connect or Google Play Console CSV import (store APIs aren't connected in the beta).", "import_csv");
    case "views": {
      if (!ctx.publicationsCount) return m("No published posts yet.", "publish_post");
      const social = ctx.connections.some((c) => c.capabilities.includes("read_insights") && c.provider !== "revenuecat" && c.status === "connected");
      if (!social) return m("Social insights aren't connected yet (platform app review pending). Import post stats or enter them manually.", "enter_manually");
      return m("No views reported in this range.", "widen_range");
    }
    case "clicks":
      if (!ctx.links.length) return m("No tracked links yet. Add one to a campaign to measure clicks.", "create_tracked_link");
      return m("No tracked links were active for this filter and range.", "create_tracked_link");
    case "ad_spend":
      return m("Ad spend appears only when you import it (no ad accounts are connected).", "import_csv");
    default:
      return m(`No ${label.toLowerCase()} data for this range.`, "import_csv");
  }
}

/** Measured zero for tracked links that were live in the range but recorded no clicks. */
function zeroClicks(ctx: InsightsContext, r: Range, filters: Filters): InsightMetric | null {
  const live = ctx.links.filter((l) => ms(l.createdAt) < r.to && (!filters.campaignId || l.campaignId === filters.campaignId) && (!filters.channel || l.channel === filters.channel));
  if (!live.length) return null;
  return {
    metric: "clicks",
    label: METRIC_INFO.clicks.label,
    unit: "count",
    value: 0,
    aggregation: "sum",
    sources: [{ source: "tracked_link", label: "MuseLaunch tracked links", imported: false, attribution: "link", value: 0, observationCount: 0, definitions: [CLICK_DEFINITION] }],
    attribution: "link",
    imported: false,
    definition: CLICK_DEFINITION,
    window: null,
    coverage: null,
    observationIds: [],
    comparison: null,
    notes: [`${live.length} tracked link${live.length > 1 ? "s were" : " was"} live and recorded no clicks in this range.`],
  };
}


function withComparison(cur: ReturnType<typeof computeMetric>, prev: ReturnType<typeof computeMetric> | null): InsightMetric {
  if (!prev) return cur;
  const comparable = cur.value !== null && prev.value !== null && cur.currency === prev.currency;
  const delta = comparable ? round(cur.value! - prev.value!) : null;
  return {
    ...cur,
    comparison: { value: prev.value, delta, deltaPct: comparable && prev.value ? Math.round(((cur.value! - prev.value!) / Math.abs(prev.value!)) * 1000) / 10 : null },
  };
}

function funnelFrom(metrics: Map<MetricName, InsightMetric>, filters: Filters): FunnelStep[] {
  const strong = (a: AttributionLevel | null) => a !== null && ATTRIBUTION_STRENGTH[a] >= ATTRIBUTION_STRENGTH.platform_reported;
  return FUNNEL_METRICS.map((metric, i) => {
    const m = metrics.get(metric)!;
    const step: FunnelStep = {
      metric,
      label: m.label,
      value: m.value,
      sourceLabel: m.sources.length ? m.sources.filter((s) => s.observationCount > 0 || s.source === "tracked_link").map((s) => s.label).join(" + ") || null : null,
      attribution: m.attribution,
      imported: m.imported,
      conversionFromPrevious: null,
    };
    if (i === 0) return step;
    const prev = metrics.get(FUNNEL_METRICS[i - 1]!)!;
    if (metric === "revenue") {
      step.conversionNote = "Revenue is money, not a step count; no conversion rate.";
    } else if (prev.value === null || m.value === null) {
      step.conversionNote = "Not computed: one of the two steps isn't measured.";
    } else if (filters.campaignId && strong(prev.attribution) && strong(m.attribution) && prev.value > 0) {
      step.conversionFromPrevious = Math.round((m.value / prev.value) * 1000) / 1000;
      step.conversionNote = `Both steps are attributed to this campaign (${prev.attribution} → ${m.attribution}).`;
    } else {
      step.conversionNote = `Not a conversion rate: ${prev.label.toLowerCase()} are ${prev.attribution ?? "unattributed"}, ${m.label.toLowerCase()} are ${m.attribution ?? "unattributed"}${filters.campaignId ? "" : " and not tied to the same campaign"}. Comparing them would imply a link that isn't measured.`;
    }
    return step;
  });
}

async function costOutcome(p: Platform, ws: WorkspaceDb, appId: string, r: Range, metrics: Map<MetricName, InsightMetric>, all: MetricObservation[], filters: Filters): Promise<CostOutcome> {
  const fromIso = new Date(r.from).toISOString();
  const toIso = new Date(r.to).toISOString();
  let usd = 0;
  let calls = 0;
  let cursor: string | null = null;
  do {
    const page = await ws.collection("modelUsage").list({ where: [["appId", "==", appId], ["createdAt", ">=", fromIso], ["createdAt", "<", toIso]], orderBy: { field: "createdAt", dir: "desc" }, limit: 500, cursor });
    for (const e of page.items) {
      usd += e.costUsdEstimate;
      calls++;
    }
    cursor = page.nextCursor;
  } while (cursor && calls < 20_000);
  let credits = 0;
  cursor = null;
  let scanned = 0;
  do {
    const page = await ws.collection("jobs").list({ where: [["appId", "==", appId], ["createdAt", ">=", fromIso], ["createdAt", "<", toIso]], orderBy: { field: "createdAt", dir: "desc" }, limit: 500, cursor });
    for (const j of page.items) credits += j.creditsCharged ?? 0;
    scanned += page.items.length;
    cursor = page.nextCursor;
  } while (cursor && scanned < 20_000);

  const spendObs = all.filter((o) => o.metric === "ad_spend" && inRange(o, r, "flow") && (!filters.campaignId || o.campaignId === filters.campaignId) && (!filters.channel || o.channel === filters.channel));
  const byCur = new Map<string, { value: number; ids: string[]; imported: boolean }>();
  for (const o of selectNonOverlapping(spendObs)) {
    const k = o.currency ?? "?";
    const cur = byCur.get(k) ?? { value: 0, ids: [], imported: false };
    cur.value += o.value;
    cur.ids.push(o.id);
    cur.imported ||= o.provenance.imported;
    byCur.set(k, cur);
  }
  const adSpend = byCur.size ? [...byCur.entries()].map(([currency, v]) => ({ currency, value: round(v.value), imported: v.imported, observationIds: v.ids.slice(0, 50) })) : null;

  const outcomes = (["clicks", "installs", "new_subscriptions", "revenue"] as MetricName[]).map((metric) => {
    const m = metrics.get(metric)!;
    return { metric, value: m.value, currency: m.currency, attribution: m.attribution, sourceLabel: m.sources[0]?.label ?? null };
  });

  const ratios: CostOutcome["ratios"] = [];
  const unknowns: string[] = ["Your own time isn't tracked."];
  if (!adSpend) unknowns.push("Ad spend: not imported.");
  const strong = (a: AttributionLevel | null) => a !== null && ATTRIBUTION_STRENGTH[a] >= ATTRIBUTION_STRENGTH.platform_reported;
  if (filters.campaignId && adSpend?.length === 1) {
    for (const o of outcomes) {
      if (o.metric === "revenue" || !o.value || !strong(o.attribution)) continue;
      ratios.push({ label: `Ad spend per ${METRIC_INFO[o.metric].label.toLowerCase().replace(/s$/, "")}`, value: round(adSpend[0]!.value / o.value), currency: adSpend[0]!.currency, basis: `Campaign ad spend ÷ ${o.metric} attributed to the same campaign (${o.attribution}).` });
    }
  }
  if (!ratios.length) unknowns.push("Cost per install/subscriber: outcomes aren't attributed to the same scope as costs, so no ratio is shown.");
  if (metrics.get("revenue")!.value === null) unknowns.push("Revenue: not measured for this range.");

  return {
    costs: {
      contentUsd: { value: Math.round(usd * 10000) / 10000, definition: "Provider cost estimate (USD) of AI calls made for this app in the range (MuseLaunch's metered cost, not your credit price).", calls },
      creditsConsumed: { value: credits, definition: "Credits charged for this app's jobs created in the range." },
      adSpend,
    },
    outcomes,
    ratios,
    unknowns,
  };
}

export async function insightsOverview(p: Platform, workspaceId: string, appId: string, q: InsightsQuery, now = Date.now()): Promise<InsightsOverview> {
  const ws = p.db.ws(workspaceId);
  await ws.collection("apps").getOrThrow(appId);
  if (q.campaignId) {
    const c = await ws.collection("campaigns").getOrThrow(q.campaignId);
    if (c.appId !== appId) throw new AppError("NOT_FOUND", "Campaign not found");
  }
  const r = resolveRange(q, now);
  const prev: Range | null = q.compare === "prev" ? { from: r.from - (r.to - r.from), to: r.from } : null;
  const filters: Filters = { channel: q.channel, campaignId: q.campaignId };
  const [{ items, truncated }, ctx] = await Promise.all([loadObservations(ws, appId, prev?.from ?? r.from, r.to), loadContext(ws, appId)]);
  const wanted = [...new Set<MetricName>([...OVERVIEW_METRICS, ...FUNNEL_METRICS])];
  const metrics = new Map<MetricName, InsightMetric>();
  const missing: MissingMetric[] = [];
  for (const metric of wanted) {
    let cur: InsightMetric = withComparison(computeMetric(metric, items, r, filters), prev ? computeMetric(metric, items, prev, filters) : null);
    if (cur.value === null && !cur.byCurrency && metric === "clicks") cur = zeroClicks(ctx, r, filters) ?? cur;
    if (cur.value === null && !cur.byCurrency) missing.push(explainMissing(metric, ctx, filters));
    metrics.set(metric, cur);
  }
  const disclaimers = [
    "Numbers come only from connected sources, your imports and manual entries. Nothing is estimated or filled in.",
    "Account-level (aggregate) numbers are not attributed to any post or campaign. A change after a launch is a correlation, not proof that the launch caused it.",
    "Imported and manual numbers are labelled as such; they are not live data.",
  ];
  if (truncated) disclaimers.push("This range has more data points than the overview reads at once; totals cover the newest 20,000 observations.");
  return {
    appId,
    range: { from: new Date(r.from).toISOString(), to: new Date(r.to).toISOString(), timezone: "UTC" },
    comparisonRange: prev ? { from: new Date(prev.from).toISOString(), to: new Date(prev.to).toISOString() } : null,
    filters,
    metrics: OVERVIEW_METRICS.map((m) => metrics.get(m)!),
    missing: missing.filter((m) => OVERVIEW_METRICS.includes(m.metric)),
    funnel: funnelFrom(metrics, filters),
    cost: await costOutcome(p, ws, appId, r, metrics, items, filters),
    connections: ctx.connections.filter((c) => c.purposes.includes("analytics")).map((c) => ({ id: c.id, provider: c.provider, status: c.status, lastSyncAt: c.lastSyncAt, lastError: c.lastError })),
    disclaimers,
    generatedAt: nowIso(),
  };
}
