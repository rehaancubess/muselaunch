import type { OutreachProspect, SourceRef } from "@muselaunch/contracts";
import { AppError, assertSafeUrl } from "@muselaunch/platform";
import { z } from "zod";

export type PublicContact = OutreachProspect["publicContacts"][number];

const EMAIL = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

/**
 * Outreach only uses PUBLICLY LISTED contact routes, each with the source where it is listed.
 * - Must have an http(s) source URL and must not be a model inference.
 * - An email must appear verbatim in the source excerpt (proof it was published there), unless the
 *   user added it themselves with the URL where it's listed. Guessed/pattern emails never pass.
 */
export function contactIsSourced(c: PublicContact): boolean {
  const s = c.source;
  if (!s || s.kind === "model_inference" || !s.url || !/^https?:\/\//.test(s.url)) return false;
  if (c.kind === "email") {
    if (!EMAIL.test(c.value)) return false;
    if (s.kind === "user_input") return true;
    return Boolean(s.excerpt && s.excerpt.toLowerCase().includes(c.value.toLowerCase()));
  }
  if (c.kind === "contact_form" || c.kind === "website" || c.kind === "business_inquiry") {
    return /^https?:\/\//.test(c.value) || EMAIL.test(c.value);
  }
  return c.value.trim().length > 0;
}

export function sanitizeContacts(contacts: readonly PublicContact[]): { contacts: PublicContact[]; removed: number } {
  const seen = new Set<string>();
  const out: PublicContact[] = [];
  for (const c of contacts) {
    if (!contactIsSourced(c)) continue;
    const key = `${c.kind}:${c.value.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return { contacts: out, removed: contacts.length - out.length };
}

const PREFERENCE: PublicContact["kind"][] = ["business_inquiry", "email", "contact_form", "dm", "website"];

/** Best publicly listed route, preferring the creator's stated business channel. */
export function pickContact(p: OutreachProspect): PublicContact | undefined {
  const { contacts } = sanitizeContacts(p.publicContacts);
  return [...contacts].sort((a, b) => PREFERENCE.indexOf(a.kind) - PREFERENCE.indexOf(b.kind))[0];
}

export const AddContactRequest = z.object({
  kind: z.enum(["email", "contact_form", "dm", "website", "business_inquiry"]),
  value: z.string().min(1).max(300),
  /** Page where this contact route is publicly listed (required). */
  sourceUrl: z.string().url().max(2048),
  excerpt: z.string().max(500).optional(),
});

/** A contact the user found and adds, with the public page it's listed on. */
export function userContact(input: z.infer<typeof AddContactRequest>, now: string): PublicContact {
  assertSafeUrl(input.sourceUrl);
  if (input.kind === "email" && !EMAIL.test(input.value)) throw new AppError("BAD_REQUEST", "Invalid email address");
  const source: SourceRef = { kind: "user_input", url: input.sourceUrl, retrievedAt: now, excerpt: input.excerpt, title: "Added by you" };
  return { kind: input.kind, value: input.value.trim(), source, verified: false };
}

/** Prospect as returned by the API: contacts filtered to sourced ones, with a count of hidden ones. */
export function prospectView(p: OutreachProspect) {
  const { contacts, removed } = sanitizeContacts(p.publicContacts);
  return { ...p, publicContacts: contacts, hiddenUnsourcedContacts: removed };
}
