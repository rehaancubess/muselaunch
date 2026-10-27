/** Typed URL builders for every page. Feature modules should link via these. */
export const routes = {
  home: () => "/",
  login: (next?: string) => (next ? `/login?next=${encodeURIComponent(next)}` : "/login"),
  onboarding: () => "/onboarding",
  invite: (token: string) => `/invite/${token}`,
  workspace: (wid: string) => `/w/${wid}`,
  newApp: (wid: string) => `/w/${wid}/apps/new`,
  settings: {
    integrations: (wid: string) => `/w/${wid}/settings/integrations`,
    team: (wid: string) => `/w/${wid}/settings/team`,
    credits: (wid: string) => `/w/${wid}/settings/credits`,
    workspace: (wid: string) => `/w/${wid}/settings`,
  },
  app: (wid: string, appId: string) => {
    const base = `/w/${wid}/a/${appId}`;
    return {
      root: base,
      discover: `${base}/discover`,
      creator: `${base}/creator`,
      newCampaign: `${base}/creator/new`,
      campaign: (campaignId: string) => `${base}/creator/campaigns/${campaignId}`,
      studio: (compositionId: string) => `${base}/creator/studio/${compositionId}`,
      insights: `${base}/insights`,
      brand: `${base}/brand`,
      library: `${base}/library`,
      calendar: `${base}/calendar`,
      run: (runId: string) => `${base}/runs/${runId}`,
    };
  },
};

export type PrimaryTab = "discover" | "creator" | "insights";
