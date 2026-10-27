"use client";
/**
 * Owner: module B (Intelligence). Agent run trace: plan, steps, tool calls, citations, usage.
 * Rendered by .../a/[appId]/runs/[runId]/page.tsx. Data: GET /agent-runs/:runId → { run, steps, usage }.
 */
import { Bot } from "lucide-react";
import { FeaturePlaceholder } from "../_placeholder";

export interface AgentRunViewProps {
  runId: string;
}

export default function AgentRunView({ runId }: AgentRunViewProps) {
  return (
    <FeaturePlaceholder
      icon={<Bot aria-hidden />}
      title="Agent run"
      description={<>The plan, steps, sources and model usage for run {runId} appear here. This view isn’t available in this build yet.</>}
    />
  );
}
