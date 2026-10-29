import type { Metadata } from "next";
import Link from "next/link";
import { ContactLine, Ext, LegalPage, List, Section } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Delete your data", description: "How to disconnect accounts and delete your MuseLaunch data." };

export default function DataDeletionPage() {
  return (
    <LegalPage
      title="Delete your data"
      intro={<p>You can remove MuseLaunch&apos;s access to your accounts yourself, and ask us to delete everything we hold about you. Here&apos;s how.</p>}
    >
      <Section title="Disconnect a social or analytics account">
        <List>
          <li>
            In MuseLaunch, open <strong className="text-ink">Settings → Integrations</strong> and choose <strong className="text-ink">Disconnect</strong> next to the account. We delete
            the stored access tokens straight away and ask the platform to revoke them where it allows.
          </li>
          <li>
            You can also remove MuseLaunch from the platform itself:{" "}
            <Ext href="https://myaccount.google.com/permissions">Google / YouTube</Ext>,{" "}
            <Ext href="https://www.facebook.com/settings?tab=business_tools">Facebook</Ext> and{" "}
            <Ext href="https://www.instagram.com/accounts/manage_access/">Instagram</Ext> (Apps and websites). Once access is removed there, MuseLaunch can no longer read or post for that
            account.
          </li>
        </List>
      </Section>

      <Section title="Remove a file or an app">
        <p>
          Delete uploaded files yourself from an app&apos;s <strong className="text-ink">Library</strong>. To remove a whole app and everything made for it, ask for deletion as described
          below and name the app.
        </p>
      </Section>

      <Section title="Delete your account and all your data">
        <p>
          Email <ContactLine subject="Delete my MuseLaunch data" /> from the address you sign in with, with the subject &quot;Delete my MuseLaunch data&quot;. We&apos;ll confirm, then
          delete your account, your workspaces and everything in them: apps, uploads, generated content, connected-account tokens and usage records. We finish within 30 days and tell you
          when it&apos;s done.
        </p>
        <p>
          If you connected Instagram or Facebook and then removed MuseLaunch there, you can send the same email; we&apos;ll delete everything we received from Meta for your account.
        </p>
      </Section>

      <Section title="More detail">
        <p>
          The <Link href="/privacy" className="text-accent underline underline-offset-2">Privacy Policy</Link> lists what we collect, who processes it and how long we keep it.
        </p>
      </Section>
    </LegalPage>
  );
}
