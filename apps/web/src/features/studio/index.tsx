"use client";
/**
 * Owner: module C (Video Studio). Replace the internals; keep the default export + props.
 * Rendered by apps/web/src/app/w/[workspaceId]/a/[appId]/creator/studio/[compositionId]/page.tsx
 * inside the app shell with a full-bleed main area (no page padding).
 *
 * Useful shell APIs: useWorkspace()/useCurrentApp() from "@/lib/workspace", useApiQuery from "@/lib/query",
 * api/wsPath from "@/lib/api", useJob from "@/lib/jobs", useAiEditCommand from "@/lib/commands"
 * (the global ⌘K palette emits AI edit instructions for the open composition).
 */
import { Clapperboard } from "lucide-react";
import { FeaturePlaceholder } from "../_placeholder";

export interface StudioRootProps {
  compositionId: string;
}

export default function StudioRoot({ compositionId }: StudioRootProps) {
  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-10 sm:px-6">
      <FeaturePlaceholder
        icon={<Clapperboard aria-hidden />}
        title="The Studio editor opens here"
        description={
          <>
            Live preview, timeline, layers, captions, audio and the conversational AI editor for composition <span className="tabular text-ink">{compositionId}</span>. This build doesn’t include the editor yet.
          </>
        }
      />
    </div>
  );
}
