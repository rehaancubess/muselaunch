"use client";
import { useParams } from "next/navigation";
import { CampaignPage } from "@/components/creator/campaign-page";
import { useCurrentApp } from "@/lib/workspace";

export default function CampaignRoute() {
  const { campaignId } = useParams<{ campaignId: string }>();
  const { workspaceId, appId } = useCurrentApp();
  return <CampaignPage workspaceId={workspaceId} appId={appId} campaignId={String(campaignId)} />;
}
