"use client";
import { PageHeader } from "@muselaunch/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AddAppForm, ImportProgress, type CreatedApp } from "@/components/onboarding/add-app";
import { PageContainer } from "@/components/page-container";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

/**
 * Add another app: paste a link → Go. With "Let MuseLaunch run it" (the workspace default) it opens the
 * app's Home, where Growth Autopilot is already waiting for the import; "I'll do it myself" shows the
 * import progress and App DNA review as before.
 */
export default function NewAppPage() {
  const { workspaceId, workspace, apps } = useWorkspace();
  const router = useRouter();
  const [created, setCreated] = useState<CreatedApp | null>(null);
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={created ? `Importing ${created.app.name === "New app" ? "your app" : created.app.name}` : apps.length ? "Add another app" : "Add your first app"}
        description={created ? "This usually takes under a minute." : "Paste its store link and MuseLaunch reads the public listing to learn the product. Nothing is posted anywhere."}
      />
      <div className="max-w-md">
        {created ? (
          <ImportProgress
            workspaceId={workspaceId}
            app={created.app}
            job={created.job}
            onContinue={() => router.push(routes.app(workspaceId, created.app.id).creator)}
            onReview={() => router.push(routes.app(workspaceId, created.app.id).brand)}
          />
        ) : (
          <AddAppForm
            workspaceId={workspaceId}
            autopilotDefault={workspace?.settings.autopilot?.enabled ?? true}
            onCreated={(c) => (c.choice === "auto" ? router.push(routes.app(workspaceId, c.app.id).creator) : setCreated(c))}
          />
        )}
      </div>
    </PageContainer>
  );
}
