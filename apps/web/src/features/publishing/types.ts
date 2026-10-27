import type { Approval, Channel, ConnectedAccount, Job, OutreachDraft, OutreachProspect, Publication, ScheduledPost, SourceRef } from "@muselaunch/contracts";

/** Response shapes of module E routes (apps/api/src/routes/{publishing,discover}.ts). */

export type Preflight = { errors: string[]; warnings: string[] };

export type PostView = {
  post: ScheduledPost;
  approval: Approval | null;
  publication: Publication | null;
  account: Pick<ConnectedAccount, "id" | "provider" | "displayName" | "status" | "limitations"> | null;
  preflight: Preflight;
  snapshotHash: string;
  statusLabel: string;
};

export type CalendarItem = {
  id: string;
  campaignId: string;
  channel: Channel;
  mode: "api" | "manual";
  status: ScheduledPost["status"];
  statusLabel: string;
  title?: string;
  scheduledAt?: string;
  at?: string;
  reminderAt?: string;
  thumbnailAssetId?: string;
  approvalId?: string;
  publication?: { id: string; mode: Publication["mode"]; remoteUrl?: string; publishedAt: string };
  lastError?: string;
};

export type CalendarResponse = {
  timezone: string;
  from: string;
  to: string;
  days: Record<string, CalendarItem[]>;
  unscheduled: CalendarItem[];
  reminders: { postId: string; at: string; due: boolean; channel: Channel }[];
  counts: Record<string, number>;
};

export type ManualPackage = {
  post: ScheduledPost;
  instructions: string[];
  copy: { title?: string; caption: string; tags: string[]; trackingUrl?: string };
  downloads: { assetId: string; role: string; kind: string; mimeType: string; bytes: number; filename: string; url: string; expiresAt: string }[];
  package?: { jobId: string; status: string; assetId?: string; url?: string; expiresAt?: string; error?: string };
};

export type SuggestedTimes = {
  channel: Channel;
  timezone: string;
  basis: "your_results" | "general_heuristic";
  note: string;
  items: { at: string; localTime: string; timezone: string; basis: "your_results" | "general_heuristic"; reason: string }[];
};

export type ProviderCatalogItem = {
  provider: ConnectedAccount["provider"];
  label: string;
  channels: Channel[];
  purposes: string[];
  capabilities: string[];
  configured: boolean;
  state: "not_configured" | "pending_review" | "available";
  review: { required: boolean; summary: string; docsUrl: string };
  env: string[];
  redirectUri: string;
  detail: string;
};

export type ConnectionsResponse = { items: ConnectedAccount[]; providers: ProviderCatalogItem[] };

export type ApprovalDetail = { approval: Approval; subject: unknown; currentHash: string | null; stale: boolean };

export type ProspectView = OutreachProspect & { hiddenUnsourcedContacts: number };
export type DraftView = { draft: OutreachDraft; prospect: ProspectView | null; approval: Approval | null; snapshotHash: string };

export type JobOut = { job: Job };

export type { SourceRef };
