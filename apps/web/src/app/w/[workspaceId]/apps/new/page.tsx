"use client";
import type { App, Job } from "@muselaunch/contracts";
import { PageHeader } from "@muselaunch/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AddAppForm, ImportProgress } from "@/components/onboarding/add-app";
import { PageContainer } from "@/components/page-container";
import { routes } from "@/lib/routes";
import { useWorkspace } from "@/lib/workspace";

export default function NewAppPage() {
  const { workspaceId, apps } = useWorkspace();
  const router = useRouter();
  const [created, setCreated] = useState<{ app: App; job: Job | null } | null>(null);
  return (
    <PageContainer width="narrow">
      <PageHeader
        title={created ? `Importing ${created.app.name === "New app" ? "your app" : created.app.name}` : apps.length ? "Add another app" : "Add your first app"}
        description={created ? "This usually takes under a minute." : "Paste a store link and Muse reads your public listing to learn the product. Nothing is posted anywhere."}
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
          <AddAppForm workspaceId={workspaceId} submitLabel="Import app" onCreated={(app, job) => setCreated({ app, job })} />
        )}
      </div>
    </PageContainer>
  );
}
