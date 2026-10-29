import type { Metadata } from "next";
import Link from "next/link";
import { ContactLine, Ext, LegalPage, List, Section, legal } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Privacy Policy", description: "What MuseLaunch collects, why, who processes it, and how to delete it." };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro={
        <p>
          MuseLaunch is an AI marketing studio for indie app developers, currently a free beta operated by {legal.operator}. This policy explains what we collect, why, which services
          process it, and how you can delete it. Questions: <ContactLine subject="Privacy question" />.
        </p>
      }
    >
      <Section title="What we collect">
        <List>
          <li>
            <strong className="text-ink">Your account:</strong> your email address, your name if you give one, and how you signed in (Google or email), through Firebase Authentication.
          </li>
          <li>
            <strong className="text-ink">Your apps:</strong> the store or website links you add, the public listing details and screenshots we fetch from them, and what you tell us
            about your app, audience and brand.
          </li>
          <li>
            <strong className="text-ink">Your content:</strong> files you upload (recordings, images, videos) and what MuseLaunch makes for you (research notes, scripts, storyboards,
            videos, images, captions, post drafts).
          </li>
          <li>
            <strong className="text-ink">Connected accounts:</strong> if you connect YouTube, Instagram, Facebook, TikTok, LinkedIn, X, Gmail or RevenueCat, we store the access tokens
            those services issue (encrypted), the account&apos;s id and name, and the posts, metrics and insights they return for your account. We only post or send anything after you
            approve it.
          </li>
          <li>
            <strong className="text-ink">Usage records:</strong> credits used, jobs run, which AI model handled each step with its token count and cost, an audit log of changes, and
            redacted records of AI requests and responses (credentials removed) so that every result can be traced.
          </li>
          <li>
            <strong className="text-ink">Tracked links:</strong> how many times a link we created for you was opened, grouped by device type (mobile, desktop, bot). We don&apos;t store
            the IP addresses of people who click.
          </li>
        </List>
      </Section>

      <Section title="How we use it">
        <p>
          Only to run MuseLaunch for you: understanding your app, researching your market, creating and editing your campaigns, publishing what you approve, measuring results, and
          keeping the service secure and within spending limits. We don&apos;t sell your data, we don&apos;t show ads, and we don&apos;t train AI models on your content.
        </p>
      </Section>

      <Section title="Who processes it">
        <p>MuseLaunch sends each service only what the step needs:</p>
        <List>
          <li>
            <strong className="text-ink">Google Cloud and Firebase</strong> (USA, us-central1): sign-in, database, file storage and hosting.
          </li>
          <li>
            <strong className="text-ink">Meta Model API</strong>: Muse Wonder, Muse Spark, SAM 3.1 and Muse Voice Transcribe, in Meta&apos;s Standard mode. We never use Contributor mode,
            where Meta may train on inputs.
          </li>
          <li>
            <strong className="text-ink">Baseten</strong>: Muse Spark Open, Meta&apos;s open-weight model, for post copy and variants.
          </li>
          <li>
            <strong className="text-ink">OpenAI</strong>: image generation and optional narration. While Meta Model API access is unavailable to us, OpenAI also temporarily handles the
            steps normally run by Muse Wonder and Muse Spark; the app shows a banner whenever that is the case.
          </li>
          <li>
            <strong className="text-ink">Muse Glimmer</strong>: Meta&apos;s open-weight model, run on hardware the operator controls, for brand and claim checks.
          </li>
          <li>
            <strong className="text-ink">Platforms you connect</strong>, for the actions you approve there.
          </li>
        </List>
      </Section>

      <Section title="Google and YouTube data">
        <p>
          MuseLaunch uses YouTube API Services. By connecting YouTube you also agree to the <Ext href="https://www.youtube.com/t/terms">YouTube Terms of Service</Ext>, and Google&apos;s
          handling of data is described in the <Ext href="https://policies.google.com/privacy">Google Privacy Policy</Ext>. MuseLaunch&apos;s use and transfer of information received
          from Google APIs adheres to the <Ext href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</Ext>, including the
          Limited Use requirements. You can revoke MuseLaunch&apos;s access at any time in <Ext href="https://myaccount.google.com/permissions">your Google account permissions</Ext>.
        </p>
      </Section>

      <Section title="How long we keep it">
        <List>
          <li>Your account, apps and content: until you delete them or ask us to (see below).</li>
          <li>Tokens for a connected account: deleted as soon as you disconnect it, and we ask the platform to revoke them where it allows.</li>
          <li>Video sent to Meta for object tracking: uploaded with an expiry of at most a few hours, and deleted after use.</li>
          <li>Usage and audit records: kept with your workspace, so costs and AI outputs stay traceable, and deleted with it.</li>
        </List>
      </Section>

      <Section title="Your choices and rights">
        <p>
          You can disconnect accounts, delete uploaded files, and ask for a copy or full deletion of your data at any time. The <Link href="/data-deletion" className="text-accent underline underline-offset-2">data deletion page</Link> explains how.
          You can also ask us to correct your data. We answer requests within 30 days.
        </p>
      </Section>

      <Section title="Security">
        <p>
          Data is encrypted in transit and at rest by Google Cloud. Access tokens for connected accounts are additionally encrypted by MuseLaunch. Each workspace&apos;s data is kept
          separate, and only its members can see it.
        </p>
      </Section>

      <Section title="Children">
        <p>MuseLaunch is for app developers and isn&apos;t intended for anyone under 16.</p>
      </Section>

      <Section title="Changes">
        <p>If this policy changes in a way that matters, we&apos;ll say so in the app before it applies. The date at the top always shows the latest version.</p>
      </Section>
    </LegalPage>
  );
}
