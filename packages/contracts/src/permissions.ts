import type { Role, WorkspaceMember } from "./tenancy";

export const CAPABILITIES = [
  "workspace.read",
  "workspace.manage",
  "workspace.delete",
  "members.manage",
  "billing.manage",
  "apps.write",
  "content.write",
  "content.approve",
  "analytics.write",
  /** External side effects. Granted per member, never implied by `editor`. */
  "publish",
  "accounts.manage",
  "outreach.send",
] as const;
export type Capability = (typeof CAPABILITIES)[number];

const ROLE_CAPS: Record<Role, readonly Capability[]> = {
  owner: CAPABILITIES,
  admin: [
    "workspace.read",
    "workspace.manage",
    "members.manage",
    "billing.manage",
    "apps.write",
    "content.write",
    "content.approve",
    "analytics.write",
  ],
  editor: ["workspace.read", "apps.write", "content.write", "analytics.write"],
  viewer: ["workspace.read"],
};

/** Effective capabilities for a member, including the separate publish/account grants. */
export function capabilitiesFor(member: Pick<WorkspaceMember, "role" | "canPublish" | "canManageAccounts" | "status">): Set<Capability> {
  if (member.status !== "active") return new Set();
  const caps = new Set<Capability>(ROLE_CAPS[member.role]);
  if (member.role === "owner" || member.canPublish) {
    caps.add("publish");
    caps.add("outreach.send");
  }
  if (member.role === "owner" || member.canManageAccounts) caps.add("accounts.manage");
  return caps;
}

export function can(member: Parameters<typeof capabilitiesFor>[0], cap: Capability): boolean {
  return capabilitiesFor(member).has(cap);
}
