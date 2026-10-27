"use client";
import { useParams } from "next/navigation";
import { PageContainer } from "@/components/page-container";
import AgentRunView from "@/features/agents";

export default function AgentRunPage() {
  const { runId } = useParams<{ runId: string }>();
  return (
    <PageContainer>
      <AgentRunView runId={String(runId)} />
    </PageContainer>
  );
}
