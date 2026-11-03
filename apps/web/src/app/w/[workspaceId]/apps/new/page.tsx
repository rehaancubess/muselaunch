"use client";
import { PageHeader, useToast } from "@muselaunch/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AddAppForm, ImportProgress, afterAdd, type CreatedApp } from "@/components/onboarding/add-app";
import { PageContainer } from "@/components/page-container";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

/**
 * Add another app: paste a link → Go. With Autopilot on (the workspace default) it opens the new
 * run's progress screen, which waits for the import and makes the first videos; when the workspace
 * turned Autopilot off in Settings it shows the import progress and the hands-on next steps.
 */
export default function NewAppPage() {
  const { workspaceId, workspace, apps } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const [created, setCreated] = useState<CreatedApp | null>(null);
  const autopilotOn = workspace?.settings.autopilot?.enabled ?? true;
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={created ? `Importing ${created.app.name === "New app" ? "your app" : created.app.name}` : apps.length ? "Add another app" : "Add your first app"}
        description={
          created
            ? "This usually takes under a minute."
            : autopilotOn
              ? "Paste its store or website link. MuseLaunch learns the app and makes its first videos."
              : "Paste its store or website link and MuseLaunch reads the public listing to learn the product."
        }
      />
      <div className="max-w-md">
        {created ? (
          <ImportProgress
            workspaceId={workspaceId}
            app={created.app}
            job={created.job}
            onContinue={() => router.push(routes.app(workspaceId, created.app.id).home)}
            onReview={() => router.push(routes.app(workspaceId, created.app.id).brand)}
          />
        ) : (
          <AddAppForm
            workspaceId={workspaceId}
            promise={autopilotOn ? "Nothing is posted and no extra credits are spent without your OK." : "Nothing is posted anywhere."}
            onCreated={(c) => {
              const to = afterAdd(c);
              if (!to) return setCreated(c);
              if (c.autopilot && !c.autopilot.started) toast.toast({ title: "Autopilot didn’t start yet", description: c.autopilot.reason ?? "See what fits on the next page.", tone: "neutral" });
              router.push(to);
            }}
          />
        )}
      </div>
    </PageContainer>
  );
}
