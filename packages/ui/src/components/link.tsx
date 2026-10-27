"use client";
import { createContext, useContext, type AnchorHTMLAttributes, type ComponentType, type ReactNode } from "react";

export type UiLinkComponent = ComponentType<AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode }>;

const LinkCtx = createContext<UiLinkComponent | null>(null);

/** Lets the host app (e.g. Next.js) supply its client-side Link for primitives that take `href`. */
export function UiLinkProvider({ component, children }: { component: UiLinkComponent; children: ReactNode }) {
  return <LinkCtx.Provider value={component}>{children}</LinkCtx.Provider>;
}

/** Anchor that uses the host app's Link when provided (client-side navigation), else a plain <a>. */
export function UiLink(props: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; children?: ReactNode }) {
  const C = useContext(LinkCtx);
  const external = /^https?:\/\//.test(props.href) || props.target === "_blank";
  if (C && !external) return <C {...props} />;
  return <a {...props} />;
}
