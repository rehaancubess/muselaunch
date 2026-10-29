import { BarChart3, Check, Plus, Rocket, ScanEye, ShieldCheck } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import {
  AUTOPILOT_POINTS,
  AUTOPILOT_ROUND_CREDITS,
  BUILT_ON,
  CONTROL,
  OPEN_WEIGHTS_NOTE,
  CREDIT_ROWS,
  FAQ,
  FREE_CREDITS,
  FREE_LIMITS,
  GUARDIAN_POINTS,
  INSIGHT_POINTS,
  OBJECT_FRAMES,
  STEPS,
  VIDEO_POINTS,
} from "@/components/landing/content";
import { BrowserFrame, PhoneFrame, ShotCard, ShotPanel } from "@/components/landing/frames";
import { HeroLinkForm, NavAuthButtons } from "@/components/landing/hero-form";
import { HeroVideo } from "@/components/landing/hero-video";
import { Logo } from "@/components/logo";
import { routes } from "@/lib/routes";

const NAV = [
  { href: "#how", label: "How it works" },
  { href: "#features", label: "Features" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

const WRAP = "mx-auto w-full max-w-[1200px] px-5 sm:px-8";
const H2 = "text-[34px] font-semibold leading-[1.06] tracking-[-0.036em] text-balance sm:text-[44px] lg:text-[54px] lg:leading-[1.04]";
const LEAD = "text-[17px] leading-[1.5] tracking-[-0.011em] sm:text-[19px] lg:text-[21px] lg:leading-[1.45]";

export default function Landing() {
  return (
    <div className="min-h-dvh overflow-x-clip bg-canvas">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-3 focus:z-50 focus:rounded-full focus:bg-ink focus:px-4 focus:py-2 focus:text-footnote focus:text-white">
        Skip to content
      </a>

      <header className="sticky top-0 z-40 border-b border-black/[0.06] bg-white/80 backdrop-blur-xl backdrop-saturate-150">
        <nav aria-label="Main" className={`${WRAP} flex h-14 items-center justify-between gap-6`}>
          <Link href="/" aria-label="MuseLaunch home" className="rounded-md">
            <Logo size={22} />
          </Link>
          <ul className="hidden items-center gap-7 md:flex">
            {NAV.map((n) => (
              <li key={n.href}>
                <a href={n.href} className="rounded-md text-footnote font-medium text-ink-2 transition-colors hover:text-ink">
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
          <NavAuthButtons />
        </nav>
      </header>

      <main id="main">
        <Hero />
        <BuiltOn />
        <HowItWorks />
        <ObjectAware />
        <Autopilot />
        <Guardian />
        <Insights />
        <Control />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>

      <Footer />
    </div>
  );
}

/* ------------------------------------------------------------------------------------------ */

function Hero() {
  return (
    <section aria-labelledby="hero-title" className="relative">
      <div className={`${WRAP} flex flex-col items-center pt-14 text-center sm:pt-20 lg:pt-[72px]`}>
        <a
          href="#pricing"
          className="animate-rise-in inline-flex h-8 items-center gap-2 rounded-full bg-mist px-3.5 text-footnote font-medium text-ink-2 transition-colors hover:bg-mist-2 hover:text-ink"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
          Free during the beta, with {FREE_CREDITS} credits to start
        </a>
        <h1
          id="hero-title"
          className="mt-7 animate-rise-in text-[clamp(2.6rem,6.4vw,4.75rem)] font-semibold leading-[1.02] tracking-[-0.045em] text-balance [animation-delay:60ms]"
        >
          Build your app.
          <br />
          MuseLaunch does the marketing.
        </h1>
        <p className={`mt-6 max-w-[40rem] animate-rise-in text-ink-2 text-balance [animation-delay:120ms] ${LEAD}`}>
          Paste your App Store or Google Play link. Growth Autopilot finds your audience, makes real promo videos from your own screens and gets every post ready. Nothing goes out until you approve it.
        </p>
        <div className="mt-9 w-full max-w-[540px] animate-rise-in [animation-delay:180ms]">
          <HeroLinkForm />
        </div>
      </div>

      {/* Product stage: straddles the white hero and the mist band below it. */}
      <div className="relative mt-14 sm:mt-16">
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[42%] bg-mist" />
        <figure className={`${WRAP} relative`}>
          <div className="relative animate-scale-in pb-12 [animation-delay:240ms] sm:pb-20 lg:pb-24">
            <BrowserFrame label="Your app’s Home" className="w-full sm:w-[82%]">
              <Image
                src="/landing/autopilot-run.webp"
                alt="An app’s Home in MuseLaunch with Autopilot on: the goal “Get more installs of Tidy Timer from students” has gone through learning the app, research, videos, checks, rendering and drafting posts, and two Instagram posts wait under “Needs you” for one-tap approval."
                width={1440}
                height={900}
                loading="eager"
                fetchPriority="high"
                sizes="(min-width: 1200px) 932px, (min-width: 640px) 82vw, 100vw"
                className="block h-auto w-full"
              />
            </BrowserFrame>
            <PhoneFrame className="absolute bottom-0 right-0 w-[38%] sm:w-[24%]">
              <HeroVideo
                src="/landing/hero-render.mp4"
                poster="/landing/hero-render-poster.webp"
                label="An object-aware promo video rendered by HyperFrames: a presenter holds a phone while the app plays behind him, then appears on his phone’s screen, then is spotlighted with a label."
              />
            </PhoneFrame>
          </div>
          <figcaption className="relative mx-auto max-w-[44rem] pb-4 text-center text-footnote text-ink-2 text-pretty sm:pb-8">
            Autopilot did the research, the videos and the checks on its own; two posts wait for your OK. Beside it, a video rendered with HyperFrames. Screens show sample data, and the presenter is a synthetic test clip.
          </figcaption>
        </figure>
      </div>
    </section>
  );
}

function BuiltOn() {
  return (
    <section aria-labelledby="built-title" className="bg-mist">
      <div className={WRAP}>
        <div className="border-t border-black/[0.07] py-10 sm:py-12">
          <h2 id="built-title" className="text-center text-footnote font-medium text-ink-2">
            Built on Meta’s models, rendered with HyperFrames
          </h2>
          <ul className="mt-5 flex flex-wrap items-center justify-center gap-x-8 gap-y-3 sm:gap-x-12">
            {BUILT_ON.map((m) => (
              <li key={m} className="text-[17px] font-semibold tracking-[-0.02em] text-ink/70 sm:text-[19px]">
                {m}
              </li>
            ))}
          </ul>
          <p className="mt-5 text-center text-footnote text-ink-3 text-pretty">{OPEN_WEIGHTS_NOTE}</p>
        </div>
      </div>
    </section>
  );
}

function HowItWorks() {
  return (
    <section id="how" aria-labelledby="how-title" className="scroll-mt-14 bg-mist">
      <div className={`${WRAP} pb-24 pt-16 sm:pb-32 sm:pt-24`}>
        <h2 id="how-title" className={`${H2} max-w-[18ch]`}>
          You bring the app. Autopilot does the rest.
        </h2>
        <ol className="mt-12 grid gap-10 sm:mt-16 md:grid-cols-3 md:gap-8">
          {STEPS.map((s, i) => (
            <li key={s.title} className="relative">
              <div className="flex items-center gap-4">
                <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-body-sm font-semibold tabular text-white">{i + 1}</span>
                {i < STEPS.length - 1 ? <span aria-hidden className="hidden h-px flex-1 bg-line-strong md:block" /> : null}
              </div>
              <h3 className="mt-5 text-title-3 font-semibold">{s.title}</h3>
              <p className="mt-2 max-w-[34ch] text-body text-ink-2 text-pretty md:text-[16px] md:leading-[24px]">{s.text}</p>
            </li>
          ))}
        </ol>
        <p className="mt-12 text-body text-ink-2">
          Prefer to do a step yourself? <a href="#control" className="font-medium text-accent-ink underline-offset-4 hover:underline">Take it over at any point.</a>
        </p>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------------------------------ */

function FeatureLabel({ icon, children, dark }: { icon: ReactNode; children: ReactNode; dark?: boolean }) {
  return (
    <p className={`flex items-center gap-2 text-[15px] font-semibold ${dark ? "text-[#a1a1a6]" : "text-ink-2"}`}>
      <span aria-hidden className={dark ? "text-[#8fa2ff]" : "text-accent"}>
        {icon}
      </span>
      {children}
    </p>
  );
}

function Points({ items }: { items: readonly { title: string; text: string }[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-4">
      {items.map((p) => (
        <div key={p.title}>
          <dt className="text-body font-semibold text-ink">{p.title}</dt>
          <dd className="mt-1 text-body text-ink-2 text-pretty">{p.text}</dd>
        </div>
      ))}
    </dl>
  );
}

function ObjectAware() {
  return (
    <section id="features" aria-labelledby="video-title" className="scroll-mt-14 bg-black text-[#f5f5f7]">
      <div className={`${WRAP} py-24 sm:py-32 lg:py-40`}>
        <div className="max-w-[46rem]">
          <FeatureLabel dark icon={<ScanEye className="size-4" />}>
            Object-aware video
          </FeatureLabel>
          <h2 id="video-title" className={`mt-4 ${H2}`}>
            Video edits that know what’s in the frame.
          </h2>
          <p className={`mt-5 text-[#a1a1a6] text-pretty ${LEAD}`}>
            Film yourself holding your phone. SAM 3.1 tracks you and the phone through every frame, so effects follow the action instead of sitting on top of it.
          </p>
        </div>

        <ul className="mt-14 grid grid-cols-3 gap-3 sm:mt-20 sm:gap-6 lg:gap-10">
          {OBJECT_FRAMES.map((f) => (
            <li key={f.src}>
              <figure>
                <Image
                  src={f.src}
                  alt={`Rendered frame for “${f.say}”: ${f.text}`}
                  width={540}
                  height={960}
                  sizes="(min-width: 1200px) 350px, 31vw"
                  className="block h-auto w-full rounded-[12px] bg-[#2b2622] shadow-[0_0_0_1px_rgb(255_255_255/0.1)] sm:rounded-[22px] lg:rounded-[28px]"
                />
                <figcaption className="mt-3 sm:mt-5">
                  <p className="text-[13px] font-semibold leading-[18px] text-[#f5f5f7] sm:text-[17px] sm:leading-6 lg:text-[19px]">“{f.say}”</p>
                  <p className="mt-1 hidden text-body text-[#a1a1a6] sm:block">{f.text}</p>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
        <p className="mt-6 text-footnote text-[#86868b]">Frames from a real HyperFrames render of a synthetic test clip.</p>

        <div className="mt-20 grid items-center gap-12 sm:mt-28 lg:grid-cols-12 lg:gap-14">
          <div className="lg:col-span-4">
            <h3 className="text-title-2 font-semibold text-balance">Direct it like you’d brief an editor.</h3>
            <dl className="mt-8 space-y-6">
              {VIDEO_POINTS.map((p) => (
                <div key={p.title} className="border-t border-white/15 pt-4">
                  <dt className="text-body font-semibold">{p.title}</dt>
                  <dd className="mt-1 text-body text-[#a1a1a6] text-pretty">{p.text}</dd>
                </div>
              ))}
            </dl>
          </div>
          <figure className="lg:col-span-8">
            <BrowserFrame label="Studio">
              <Image
                src="/landing/studio-ask-muse.webp"
                alt="The MuseLaunch Studio: a 9:16 preview with person and phone tracking boxes, a scene timeline, and an Ask Muse request to make the video look like an Apple product commercial with the app behind the presenter and three different hooks."
                width={1440}
                height={872}
                sizes="(min-width: 1200px) 760px, (min-width: 1024px) 64vw, 100vw"
                className="block h-auto w-full"
              />
            </BrowserFrame>
            <figcaption className="mt-3 text-footnote text-[#86868b]">The Studio with Ask Muse open. Sample project.</figcaption>
          </figure>
        </div>
      </div>
    </section>
  );
}

function FeatureRow({
  id,
  label,
  icon,
  title,
  lead,
  points,
  visual,
  first,
}: {
  id: string;
  label: string;
  icon: ReactNode;
  title: string;
  lead: string;
  points: readonly { title: string; text: string }[];
  visual: ReactNode;
  first?: boolean;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-14">
      <div className={WRAP}>
        <div className={`py-20 sm:py-28 lg:py-32 ${first ? "" : "border-t border-line"}`}>
          <div className="grid gap-5 lg:grid-cols-12 lg:items-end lg:gap-16">
            <div className="lg:col-span-6">
              <FeatureLabel icon={icon}>{label}</FeatureLabel>
              <h2 id={`${id}-title`} className={`mt-4 ${H2} lg:text-[48px] lg:leading-[1.05]`}>
                {title}
              </h2>
            </div>
            <p className={`text-ink-2 text-pretty lg:col-span-6 ${LEAD} lg:text-[19px]`}>{lead}</p>
          </div>
          <div className="mt-10 sm:mt-14">{visual}</div>
          <div className="mt-10 sm:mt-14">
            <Points items={points} />
          </div>
        </div>
      </div>
    </section>
  );
}

function Autopilot() {
  return (
    <FeatureRow
      id="autopilot"
      first
      label="Growth Autopilot"
      icon={<Rocket className="size-4" />}
      title="Marketing on autopilot, with a budget and brakes."
      lead="Give Muse Wonder a goal, like more installs from students before exams. It runs one bounded experiment at a time inside the credit budget you set, and logs every decision with the research behind it."
      points={AUTOPILOT_POINTS}
      visual={
        <ShotPanel caption="The decision log, budget and experiment from a Growth Autopilot run. Sample data.">
          <ShotCard className="mx-auto max-w-[1040px]">
            <Image
              src="/landing/autopilot-log.webp"
              alt="Growth Autopilot decision log beside its budget. Muse Wonder started with the goal and a 50-credit budget, understood the app from its App DNA, delegated live web research that succeeded for 40 credits, and cited a source retrieved on 28 October. The side panel shows 77 of 93 credits used, renders never run without asking, the chosen audience of university students revising for exams, and a two-variant experiment."
              width={1280}
              height={552}
              sizes="(min-width: 1200px) 1040px, 92vw"
              className="block h-auto w-full"
            />
          </ShotCard>
        </ShotPanel>
      }
    />
  );
}

function Guardian() {
  return (
    <FeatureRow
      id="guardian"
      label="Brand Guardian"
      icon={<ShieldCheck className="size-4" />}
      title="A private check before anything reaches you."
      lead="A self-hosted Muse Glimmer model reviews every video, caption and post against your brand voice and the claims you’ve verified. It works alongside deterministic rules, before you’re asked to approve."
      points={GUARDIAN_POINTS}
      visual={
        <ShotPanel caption="Claims and brand voice in App DNA, which the guardian checks every asset against. Sample app.">
          <ShotCard className="mx-auto max-w-[860px]">
            <Image
              src="/landing/guardian-claims.webp"
              alt="Claims to review: “Helps you get more done every week” and “The #1 focus app for students” are both flagged Beyond evidence, with Reject and Verify buttons. Below, the brand kit voice: tone calm and encouraging, words to use focus and calm, words to avoid hustle."
              width={940}
              height={587}
              sizes="(min-width: 1200px) 860px, 92vw"
              className="block h-auto w-full"
            />
          </ShotCard>
        </ShotPanel>
      }
    />
  );
}

function Insights() {
  return (
    <FeatureRow
      id="insights"
      label="Insights"
      icon={<BarChart3 className="size-4" />}
      title="Only numbers that were actually measured."
      lead="Connect RevenueCat, import store and social analytics, and count clicks with tracked links. Every number names its source, and anything that wasn’t measured is shown as missing, not estimated."
      points={INSIGHT_POINTS}
      visual={
        <ShotPanel caption="Insights with sample data imported from a CSV file.">
          <ShotCard className="mx-auto max-w-[1040px]">
            <Image
              src="/landing/insights-results.webp"
              alt="Insights results: views, link clicks, installs, trials started and revenue, each labelled with its source such as Imported CSV or MuseLaunch tracked links, its attribution level, and how many days of data it covers. A note lists what wasn’t measured."
              width={1284}
              height={550}
              sizes="(min-width: 1200px) 1040px, 92vw"
              className="block h-auto w-full"
            />
          </ShotCard>
        </ShotPanel>
      }
    />
  );
}

function Control() {
  return (
    <section id="control" aria-labelledby="control-title" className="scroll-mt-14 bg-mist">
      <div className={`${WRAP} py-24 sm:py-32`}>
        <div className="grid gap-6 lg:grid-cols-12 lg:items-end">
          <h2 id="control-title" className={`${H2} lg:col-span-6`}>
            You stay in control.
          </h2>
          <p className={`text-ink-2 text-pretty lg:col-span-6 ${LEAD} lg:text-[19px]`}>
            MuseLaunch does the work by default. The decisions stay yours, and nothing it tells you is made up.
          </p>
        </div>
        <figure className="mt-12 sm:mt-16">
          <ShotCard>
            <Image
              src="/landing/approvals.webp"
              alt="Calendar, waiting for approval: two Instagram posts marked Pending, each tied to a specific version, with Approve this version and Reject buttons. Nothing is published until that exact version is approved."
              width={1280}
              height={260}
              sizes="(min-width: 1200px) 1136px, 100vw"
              className="hidden h-auto w-full sm:block"
            />
            <Image
              src="/landing/approvals-one.webp"
              alt="Calendar, waiting for approval: an Instagram post marked Pending for a specific version, with Approve this version and Reject buttons. Nothing is published until that exact version is approved."
              width={642}
              height={260}
              sizes="100vw"
              className="block h-auto w-full sm:hidden"
            />
          </ShotCard>
          <figcaption className="mt-3 text-footnote text-ink-2">Posts waiting for approval in the Calendar. Sample data.</figcaption>
        </figure>
        <ul className="mt-14 grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {CONTROL.map((c) => (
            <li key={c.title} className="flex gap-3.5">
              <span aria-hidden className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-white text-accent shadow-[0_0_0_1px_rgb(0_0_0/0.06)]">
                <Check className="size-3.5" strokeWidth={2.5} />
              </span>
              <div>
                <h3 className="text-body font-semibold">{c.title}</h3>
                <p className="mt-1 text-body text-ink-2 text-pretty">{c.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Pricing() {
  return (
    <section id="pricing" aria-labelledby="pricing-title" className="scroll-mt-14">
      <div className={`${WRAP} grid gap-12 py-24 sm:py-32 lg:grid-cols-12 lg:gap-16`}>
        <div className="lg:col-span-5">
          <h2 id="pricing-title" className={H2}>
            Free while we’re in beta.
          </h2>
          <p className={`mt-5 text-ink-2 text-pretty ${LEAD} lg:text-[19px]`}>
            Every workspace gets {FREE_CREDITS} credits a month, starting the day you sign up. Each action shows its cost before it runs, and credits a task doesn’t use are released.
          </p>
          <p className="mt-6 text-body text-ink-2 text-pretty">
            Payments aren’t switched on during the beta, so there’s nothing to buy. If you need a bigger allowance, request one from Credits &amp; billing.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:col-span-7">
          <div className="flex flex-col rounded-[22px] bg-white p-6 shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_24px_48px_-28px_rgb(0_0_0/0.3)] sm:p-7">
            <h3 className="text-body font-semibold">Free beta</h3>
            <p className="mt-5 flex items-baseline gap-2">
              <span className="text-[44px] font-semibold leading-none tracking-[-0.04em] tabular">{FREE_CREDITS}</span>
              <span className="text-body text-ink-2">credits a month</span>
            </p>
            <ul className="mb-8 mt-6 space-y-2.5 border-t border-line pt-5">
              {FREE_LIMITS.map((l) => (
                <li key={l} className="flex gap-2.5 text-body text-ink">
                  <Check aria-hidden className="mt-[3px] size-4 shrink-0 text-accent" strokeWidth={2.5} />
                  {l}
                </li>
              ))}
              <li className="flex gap-2.5 text-body text-ink">
                <Check aria-hidden className="mt-[3px] size-4 shrink-0 text-accent" strokeWidth={2.5} />
                Every feature on this page
              </li>
            </ul>
            <a
              href={routes.login(routes.onboarding())}
              className="mt-auto inline-flex h-11 items-center justify-center rounded-full bg-accent px-5 text-body font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:shadow-focus"
            >
              Get started free
            </a>
          </div>

          <div className="rounded-[22px] bg-mist p-6 sm:p-7">
            <h3 className="text-body font-semibold">What credits pay for</h3>
            <table className="mt-4 w-full text-body">
              <caption className="sr-only">Credits per action</caption>
              <thead className="sr-only">
                <tr>
                  <th scope="col">Action</th>
                  <th scope="col">Credits</th>
                </tr>
              </thead>
              <tbody>
                {CREDIT_ROWS.map((r) => (
                  <tr key={r.label} className="border-t border-black/[0.07] first:border-t-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal text-ink-2">
                      {r.label}
                    </th>
                    <td className="py-2 text-right font-medium tabular text-ink">{r.credits === 0 ? "Free" : r.credits}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-4 border-t border-black/[0.07] pt-4 text-footnote text-ink-2 text-pretty">
              One Growth Autopilot round with two video variants is estimated at about {AUTOPILOT_ROUND_CREDITS} credits.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="scroll-mt-14">
      <div className={`${WRAP} grid gap-10 border-t border-line py-24 sm:py-32 lg:grid-cols-12 lg:gap-16`}>
        <h2 id="faq-title" className={`${H2} lg:col-span-4`}>
          Questions, answered.
        </h2>
        <div className="border-b border-line lg:col-span-8">
          {FAQ.map((f) => (
            <details key={f.q} className="group border-t border-line">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 rounded-md py-5 text-[17px] font-semibold tracking-[-0.012em] [&::-webkit-details-marker]:hidden">
                {f.q}
                <Plus aria-hidden className="size-5 shrink-0 text-ink-2 transition-transform duration-200 group-open:rotate-45" />
              </summary>
              <p className="-mt-1 max-w-[62ch] pb-6 text-body text-ink-2 text-pretty sm:text-[16px] sm:leading-[25px]">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="bg-mist">
      <div className={`${WRAP} flex flex-col items-center py-24 text-center sm:py-32`}>
        <h2 id="cta-title" className={`${H2} max-w-[20ch]`}>
          You built something good. Let’s help the world discover it.
        </h2>
        <p className={`mt-5 max-w-[34rem] text-ink-2 text-balance ${LEAD} lg:text-[19px]`}>Paste your link and Growth Autopilot gets to work. You approve what goes out.</p>
        <div className="mt-9 w-full max-w-[540px]">
          <HeroLinkForm id="cta-link" />
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-line">
      <div className={WRAP}>
        <div className="flex flex-col gap-8 py-12 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <Logo size={20} />
            <p className="mt-3 text-footnote text-ink-2">The AI growth studio for indie app developers. Built for the Meta Global AI Developer Hackathon, 2026.</p>
          </div>
          <nav aria-label="Footer">
            <ul className="grid grid-cols-2 gap-x-10 gap-y-2.5 text-footnote">
              {NAV.map((n) => (
                <li key={n.href}>
                  <a href={n.href} className="text-ink-2 transition-colors hover:text-ink">
                    {n.label}
                  </a>
                </li>
              ))}
              <li>
                <a href={routes.login()} className="text-ink-2 transition-colors hover:text-ink">
                  Sign in
                </a>
              </li>
              <li>
                <a href={routes.login(routes.onboarding())} className="text-ink-2 transition-colors hover:text-ink">
                  Get started
                </a>
              </li>
            </ul>
          </nav>
        </div>
        <div className="border-t border-line py-6">
          <p className="text-caption text-ink-2">Screenshots on this page come from MuseLaunch with sample data. No results shown here are customer results.</p>
        </div>
      </div>
    </footer>
  );
}
