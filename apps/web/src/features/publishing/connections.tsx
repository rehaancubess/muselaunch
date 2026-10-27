"use client";
import { Badge, Button, List, ListRow, Notice, ProvenanceBadge, StatusPill, statusKindOf, useToast } from "@muselaunch/ui";
import { ExternalLink, Link2, Unplug } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { QueryState } from "@/components/states";
import { api, errorMessage, wsPath } from "@/lib/api";
import { useApiQuery, useInvalidate } from "@/lib/query";
import { useWorkspace } from "@/lib/workspace";
import type { ConnectionsResponse, ProviderCatalogItem } from "./types";

const STATE_BADGE: Record<ProviderCatalogItem["state"], ReactNode> = {
  not_configured: <ProvenanceBadge kind="not_connected" label="Not set up on this deployment" />,
  pending_review: <ProvenanceBadge kind="pending_approval" label="Limited until app review" />,
  available: <Badge tone="success">Available</Badge>,
};

/**
 * Publishing/outreach connections. Honest states: a provider without OAuth credentials can't be
 * connected (manual posting instead); one awaiting the provider's app review works only for
 * accounts registered with the developer app, with the limits listed.
 */
export function ConnectionsPanel({ appId }: { appId?: string }) {
  const { workspaceId, can } = useWorkspace();
  const path = wsPath(workspaceId, "/connections");
  const q = useApiQuery<ConnectionsResponse>(path);
  const invalidate = useInvalidate();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const manage = can("accounts.manage");

  // OAuth return (security review N1): the callback only parked a PENDING connection. The signed-in
  // user finishes it here; the API attaches it only if this user started it. The completion token is
  // stripped from the URL immediately so it doesn't linger in history.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current) return;
    handled.current = true;
    const sp = new URLSearchParams(window.location.search);
    if (!sp.has("connections") && !sp.has("finish")) return;
    const finish = sp.get("finish");
    const status = sp.get("status");
    const message = sp.get("message");
    for (const k of ["connections", "finish", "status", "provider", "message", "account"]) sp.delete(k);
    window.history.replaceState(window.history.state, "", `${window.location.pathname}${sp.toString() ? `?${sp}` : ""}`);
    if (finish) {
      api
        .post<{ account: { displayName: string } }>(wsPath(workspaceId, "/connections/finish"), { token: finish })
        .then((r) => {
          toast.success("Account connected", r.account.displayName);
          void invalidate(path);
        })
        .catch((e) => toast.error("The account wasn’t connected", errorMessage(e)));
    } else if (status === "cancelled" || status === "error") {
      toast.error("Connection didn’t complete", message ?? undefined);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const connect = async (provider: string) => {
    setBusy(provider);
    try {
      const r = await api.post<{ authorizeUrl: string }>(wsPath(workspaceId, `/connections/${provider}/start`), { appId });
      window.location.assign(r.authorizeUrl);
    } catch (e) {
      toast.error("Couldn’t start the connection", errorMessage(e));
      setBusy(null);
    }
  };
  const disconnect = async (id: string) => {
    setBusy(id);
    try {
      const r = await api.del<{ note?: string }>(wsPath(workspaceId, `/connections/${id}`));
      toast.toast({ title: "Disconnected", description: r.note, tone: "neutral" });
      await invalidate(path);
    } catch (e) {
      toast.error("Couldn’t disconnect", errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <QueryState query={q} feature="Connections">
      {(data) => {
        const accounts = data.items.filter((a) => a.status !== "revoked");
        return (
          <div className="space-y-6">
            {!manage ? <Notice tone="neutral">Only members with the “Manage accounts” permission can connect or disconnect accounts.</Notice> : null}
            {accounts.length ? (
              <List label="Connected accounts">
                {accounts.map((a) => (
                  <ListRow
                    key={a.id}
                    title={a.displayName}
                    subtitle={[data.providers.find((p) => p.provider === a.provider)?.label ?? a.provider, ...a.limitations].join(" · ")}
                    trailing={
                      <>
                        <StatusPill status={statusKindOf(a.status === "expired" ? "needs_review" : a.status)}>{a.status === "expired" ? "Reconnect needed" : a.status}</StatusPill>
                        {manage && data.providers.some((p) => p.provider === a.provider) ? (
                          <Button size="sm" variant="ghost" icon={<Unplug aria-hidden />} loading={busy === a.id} onClick={() => disconnect(a.id)}>
                            Disconnect
                          </Button>
                        ) : null}
                      </>
                    }
                  />
                ))}
              </List>
            ) : null}
            <List label="Available services">
              {data.providers.map((p) => (
                <ListRow
                  key={p.provider}
                  title={
                    <span className="flex items-center gap-2">
                      {p.label} {STATE_BADGE[p.state]}
                    </span>
                  }
                  subtitle={p.detail}
                  trailing={
                    <>
                      <a href={p.review.docsUrl} target="_blank" rel="noopener noreferrer" className="text-footnote text-ink-2 hover:text-ink" title={p.review.summary}>
                        <ExternalLink className="size-3.5" aria-label="Provider docs" />
                      </a>
                      <Button size="sm" variant="outline" icon={<Link2 aria-hidden />} disabled={!manage || !p.configured} loading={busy === p.provider} onClick={() => connect(p.provider)} title={p.configured ? undefined : p.detail}>
                        Connect
                      </Button>
                    </>
                  }
                >
                  {p.state !== "available" ? <p className="mt-1 whitespace-normal text-caption text-ink-3">{p.review.summary}</p> : null}
                </ListRow>
              ))}
            </List>
            <p className="text-caption text-ink-3">Tokens are stored encrypted and are never shown. Nothing is posted or sent without an approval of the exact content.</p>
          </div>
        );
      }}
    </QueryState>
  );
}
