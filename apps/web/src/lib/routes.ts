/** Typed URL builders for every page. Feature modules should link via these. */
export const routes = {
  home: () => "/",
  login: (next?: string) => (next ? `/login?next=${encodeURIComponent(next)}` : "/login"),
  onboarding: () => "/onboarding",
  invite: (token: string) => `/invite/${token}`,
  workspace: (wid: string) => `/w/${wid}`,
  newApp: (wid: string) => `/w/${wid}/apps/new`,
  /** Every decision waiting on a person, across the workspace's apps (or one app). */
  needsYou: (wid: string, appId?: string | null) => (appId ? `/w/${wid}/needs-you?appId=${encodeURIComponent(appId)}` : `/w/${wid}/needs-you`),
  /** One Settings page with sections; each section keeps its own URL. */
  settings: {
    workspace: (wid: string) => `/w/${wid}/settings`,
    integrations: (wid: string) => `/w/${wid}/settings/integrations`,
    team: (wid: string) => `/w/${wid}/settings/team`,
    credits: (wid: string) => `/w/${wid}/settings/credits`,
  },
  app: (wid: string, appId: string) => {
    const base = `/w/${wid}/a/${appId}`;
    return {
      root: base,
      /** Home: what's ready to review, what's coming up, what needs you (the app opens here). */
      home: `${base}/home`,
      /** Create: "What would you like to make?" (promote, show a feature, a suggested idea) + your content. `opts` prefill it. */
      create: (opts: { kind?: "promote" | "feature" | "idea"; prompt?: string; ideaId?: string } = {}) => {
        const q = new URLSearchParams();
        if (opts.kind) q.set("kind", opts.kind);
        if (opts.prompt) q.set("prompt", opts.prompt);
        if (opts.ideaId) q.set("idea", opts.ideaId);
        const s = q.toString();
        return s ? `${base}/create?${s}` : `${base}/create`;
      },
      /** Results: "See what is working": measured numbers, a chart, the best post and one tip. */
      results: `${base}/results`,
      /** Discover: "What Muse found", the few best ideas for this app. */
      discover: `${base}/discover`,
      /** Discover → See everything: every finding, filters, saved ideas, creators. */
      discoverAll: `${base}/discover/all`,
      /** Creator → Today (the Creator tab opens here): the next post, what needs you, how it's going. */
      creator: `${base}/creator`,
      /** Creator → Make: plan a campaign yourself, Autopilot runs, campaigns (power users). */
      make: `${base}/creator/make`,
      /** Creator → Videos (the app's files: renders, recordings, screenshots, clips). */
      videos: `${base}/creator/videos`,
      /** Creator → Scheduled (posts, approvals and publishing). */
      scheduled: `${base}/creator/scheduled`,
      newCampaign: `${base}/creator/new`,
      campaign: (campaignId: string) => `${base}/creator/campaigns/${campaignId}`,
      studio: (compositionId: string) => `${base}/creator/studio/${compositionId}`,
      /** Insights: "How it's going", up to three measured numbers and the next step. */
      insights: `${base}/insights`,
      /** Insights → Details: filters, tests, what to try next, YouTube, data sources. `tab` / `focus` open one. */
      insightsDetails: (tab?: "overview" | "experiments" | "next" | "youtube" | "sources", opts: { focus?: "revenuecat" | "csv" | "manual" | "links"; open?: string } = {}) => {
        const q = new URLSearchParams();
        if (tab) q.set("tab", tab);
        if (opts.focus) q.set("focus", opts.focus);
        if (opts.open) q.set("open", opts.open);
        const s = q.toString();
        return s ? `${base}/insights/details?${s}` : `${base}/insights/details`;
      },
      /** Autopilot (module B owns the page body: features/autopilot). Reached from Creator. */
      autopilot: `${base}/autopilot`,
      /** About your app (App DNA, facts, brand kit). */
      about: `${base}/brand`,
      /** Same page as `about` (the URL stays /brand). */
      brand: `${base}/brand`,
      /** Old name for Creator → Videos (/library redirects there). */
      library: `${base}/creator/videos`,
      /** Old name for Creator → Scheduled (/calendar redirects there). */
      calendar: `${base}/creator/scheduled`,
      run: (runId: string) => `${base}/runs/${runId}`,
    };
  },
};

/** `path` with an incoming query kept (pages that moved redirect to their new URL with it). */
export function withQuery(path: string, searchParams: Record<string, string | string[] | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(searchParams)) {
    if (Array.isArray(v)) for (const x of v) q.append(k, x);
    else if (v !== undefined) q.set(k, v);
  }
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export type PrimaryTab = "discover" | "creator" | "insights";

/** Creator's pages behind Today (power users). */
export type CreatorView = "make" | "videos" | "scheduled";
