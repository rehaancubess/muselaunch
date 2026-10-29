import type { Metadata } from "next";
import Link from "next/link";
import { ContactLine, Ext, LegalPage, List, Section, legal } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Terms of Service · MuseLaunch", description: "The terms for using the MuseLaunch beta." };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro={
        <p>
          These terms cover your use of MuseLaunch, a free beta operated by {legal.operator}. By creating an account you agree to them. Questions: <ContactLine subject="Terms question" />.
        </p>
      }
    >
      <Section title="The beta">
        <p>
          MuseLaunch is free during the beta. New workspaces get credits that pay for AI work; when they run out, work stops until more are added. Features may change, and the service
          may be unavailable at times. We&apos;ll tell you in the app before anything you rely on goes away.
        </p>
      </Section>

      <Section title="Your account">
        <p>
          Keep your sign-in secure; you&apos;re responsible for what happens in your workspace. If you invite teammates, they act within the role you give them.
        </p>
      </Section>

      <Section title="Your content and what MuseLaunch makes">
        <List>
          <li>You keep ownership of everything you bring: your app, your listings, your uploads and your brand.</li>
          <li>
            What MuseLaunch generates for you is yours to use, subject to the terms of the AI providers that produced it (listed in the{" "}
            <Link href="/privacy" className="text-accent underline underline-offset-2">Privacy Policy</Link>).
          </li>
          <li>You give us permission to store and process your content only to run the service for you.</li>
          <li>You confirm you have the rights to anything you upload, including people who appear in recordings.</li>
        </List>
      </Section>

      <Section title="AI output needs your review">
        <p>
          MuseLaunch uses AI models. Their output can be wrong, out of date or unsuitable, even when it cites sources. Review everything before you publish or send it. Nothing is posted
          or sent without your approval, and you are responsible for what you choose to publish, including any claims about your app. Research findings and recommendations are
          suggestions, not guarantees of results.
        </p>
      </Section>

      <Section title="Acceptable use">
        <p>Don&apos;t use MuseLaunch to:</p>
        <List>
          <li>break the law or anyone&apos;s rights, including copyright, trademarks and privacy;</li>
          <li>make false or misleading claims, fake reviews or testimonials, or impersonate anyone;</li>
          <li>send spam or unsolicited bulk messages, or break the rules of the platforms you publish to;</li>
          <li>create harmful, hateful, sexual or deceptive content, or anything involving minors in an unsafe way;</li>
          <li>attack, overload or reverse-engineer the service, or get around its limits.</li>
        </List>
        <p>We may suspend workspaces that do, and we&apos;ll explain why where we can.</p>
      </Section>

      <Section title="Connected services">
        <p>
          When you connect YouTube, Instagram, Facebook, TikTok, LinkedIn, X, Gmail or RevenueCat, their own terms also apply to what you do there. Using YouTube through MuseLaunch means
          you agree to the <Ext href="https://www.youtube.com/t/terms">YouTube Terms of Service</Ext>. You can disconnect any account at any time.
        </p>
      </Section>

      <Section title="No warranty, limited liability">
        <p>
          MuseLaunch is provided as is during the beta, without warranties of any kind. To the extent the law allows, we aren&apos;t liable for indirect or consequential losses, lost
          profits or lost data, and our total liability is limited to the amount you paid us in the past 12 months (zero during the free beta).
        </p>
      </Section>

      <Section title="Ending">
        <p>
          You can stop using MuseLaunch and ask for your data to be deleted at any time (see{" "}
          <Link href="/data-deletion" className="text-accent underline underline-offset-2">data deletion</Link>). We may end the beta with reasonable notice in the app, and give you a
          chance to export your work first.
        </p>
      </Section>

      <Section title="Changes">
        <p>We may update these terms. If a change matters, we&apos;ll tell you in the app before it applies. The date at the top always shows the latest version.</p>
      </Section>
    </LegalPage>
  );
}
