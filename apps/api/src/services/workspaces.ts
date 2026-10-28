import { createHash, randomBytes } from "node:crypto";
import { DEFAULT_AUTOPILOT_SETTINGS, type Invite, type Role, type UserProfile, type Workspace, type WorkspaceMember } from "@muselaunch/contracts";
import { newId, nowIso } from "@muselaunch/db";
import { AppError, type AuthUser, type Platform } from "@muselaunch/platform";

const MAX_WORKSPACES_PER_USER = 5;

export async function ensureUser(p: Platform, user: AuthUser): Promise<UserProfile> {
  const users = p.db.top("users");
  const existing = await users.get(user.uid);
  if (existing) return existing;
  const now = nowIso();
  const profile: UserProfile = { id: user.uid, email: user.email, displayName: user.name, photoUrl: user.picture, workspaceIds: [], createdAt: now, updatedAt: now };
  await users.set(user.uid, profile);
  return profile;
}

function slugify(name: string) {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "workspace"
  );
}

/** Create a workspace with the caller as owner, free plan and signup credits. */
export async function createWorkspace(p: Platform, user: AuthUser, name: string): Promise<{ workspace: Workspace; member: WorkspaceMember }> {
  const profile = await ensureUser(p, user);
  if (profile.workspaceIds.length >= MAX_WORKSPACES_PER_USER) throw new AppError("QUOTA_EXCEEDED", `You can own up to ${MAX_WORKSPACES_PER_USER} workspaces in the beta`);
  const id = newId("ws");
  const now = nowIso();
  const workspace: Workspace = {
    id,
    workspaceId: id,
    name,
    slug: `${slugify(name)}-${id.slice(-5)}`,
    ownerId: user.uid,
    planId: "free",
    spendCeilingUsd: p.cfg.WORKSPACE_MONTHLY_SPEND_CEILING_USD,
    settings: { defaultTimezone: "UTC", defaultLocale: "en", metaDataMode: "standard", autopilot: { ...DEFAULT_AUTOPILOT_SETTINGS } },
    createdAt: now,
    updatedAt: now,
    createdBy: user.uid,
  };
  await p.db.top("workspaces").set(id, workspace);
  const member = await p.db
    .ws(id)
    .collection("members")
    .create({ id: user.uid, userId: user.uid, email: user.email, displayName: user.name, role: "owner", canPublish: true, canManageAccounts: true, status: "active" }, { actor: user.uid });
  await p.db.top("users").update(user.uid, { workspaceIds: [...profile.workspaceIds, id], defaultWorkspaceId: profile.defaultWorkspaceId ?? id });
  await p.credits.ensureAccount(id, { grant: p.cfg.SIGNUP_CREDITS, reason: "Beta signup credits", actor: user.uid });
  const start = new Date();
  const end = new Date(start.getTime() + 30 * 86_400_000);
  await p.db.ws(id).collection("subscriptions").create({ id: "current", planId: "free", status: "active", provider: "none", currentPeriodStart: start.toISOString(), currentPeriodEnd: end.toISOString() }, { actor: user.uid });
  await audit(p, id, user.uid, "workspace.created", { name });
  return { workspace, member };
}

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export async function createInvite(p: Platform, workspaceId: string, actor: string, email: string, role: Exclude<Role, "owner">): Promise<{ invite: Invite; token: string; url: string }> {
  const token = randomBytes(24).toString("base64url");
  const tokenHash = hashToken(token);
  const now = nowIso();
  const invite: Invite = {
    id: tokenHash,
    workspaceId,
    email: email.toLowerCase(),
    role,
    tokenHash,
    status: "pending",
    expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
    createdAt: now,
    updatedAt: now,
    createdBy: actor,
  };
  await p.db.top("invites").set(tokenHash, invite);
  await audit(p, workspaceId, actor, "member.invited", { email: invite.email, role });
  return { invite, token, url: `${p.cfg.PUBLIC_WEB_URL}/invite/${token}` };
}

export async function acceptInvite(p: Platform, user: AuthUser, token: string): Promise<{ workspaceId: string; member: WorkspaceMember }> {
  const invite = await p.db.top("invites").get(hashToken(token));
  if (!invite || invite.status !== "pending") throw new AppError("NOT_FOUND", "Invite not found or already used");
  if (Date.parse(invite.expiresAt) < Date.now()) throw new AppError("CONFLICT", "Invite expired", { userMessage: "This invite has expired. Ask for a new one." });
  if (!user.email || user.email.toLowerCase() !== invite.email || (user.provider === "firebase" && !user.emailVerified)) {
    throw new AppError("FORBIDDEN", "Invite is for a different email", { userMessage: `Sign in as ${invite.email} (verified) to accept this invite.` });
  }
  const profile = await ensureUser(p, user);
  const members = p.db.ws(invite.workspaceId).collection("members");
  const existing = await members.get(user.uid);
  // Plan seat limit is checked again here: it is only checked against *active* members when inviting,
  // so several outstanding invites could otherwise all be accepted past the limit.
  if (existing?.status !== "active") {
    const workspace = await p.db.top("workspaces").get(invite.workspaceId);
    const plan = p.credits.plans[workspace?.planId as keyof typeof p.credits.plans] ?? p.credits.plans.free;
    const active = (await members.list({ limit: 200 })).items.filter((m) => m.status === "active").length;
    if (active >= plan.limits.members) throw new AppError("QUOTA_EXCEEDED", `Plan allows ${plan.limits.members} members`, { userMessage: "This workspace has no free seats on its plan. Ask the owner to upgrade or remove a member." });
  }
  // SECURITY: an invite never changes the role of someone who is already an active member. Otherwise an
  // admin could send the OWNER an invite with role "viewer"; one click demoted the owner, after which the
  // admin could remove them and keep the workspace. Role changes go through PATCH /members/:uid.
  const member =
    existing?.status === "active"
      ? existing
      : existing
        ? await members.update(user.uid, { role: invite.role, status: "active" }, { actor: user.uid })
        : await members.create({ id: user.uid, userId: user.uid, email: user.email, displayName: user.name, role: invite.role, canPublish: false, canManageAccounts: false, status: "active" }, { actor: user.uid });
  await p.db.top("invites").update(invite.id, { status: "accepted", acceptedBy: user.uid, acceptedAt: nowIso() });
  if (!profile.workspaceIds.includes(invite.workspaceId)) {
    await p.db.top("users").update(user.uid, { workspaceIds: [...profile.workspaceIds, invite.workspaceId], defaultWorkspaceId: profile.defaultWorkspaceId ?? invite.workspaceId });
  }
  await audit(p, invite.workspaceId, user.uid, "member.joined", { role: invite.role });
  return { workspaceId: invite.workspaceId, member };
}

export async function audit(p: Platform, workspaceId: string, actor: string, action: string, data?: Record<string, unknown>, target?: { entity: string; id: string }) {
  try {
    await p.db.ws(workspaceId).collection("auditLog").create({ action, data, target }, { actor });
  } catch (err) {
    p.log.warn({ err, action }, "audit write failed");
  }
}
