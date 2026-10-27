import { redirect } from "next/navigation";

export default async function AppRoot({ params }: { params: Promise<{ workspaceId: string; appId: string }> }) {
  const { workspaceId, appId } = await params;
  redirect(`/w/${workspaceId}/a/${appId}/creator`);
}
