import { Film } from "lucide-react";
import Link from "next/link";
import { HeroLinkForm, NavAuthButtons } from "@/components/landing/hero-form";
import { TabsShowcase } from "@/components/landing/tabs-showcase";
import { Logo } from "@/components/logo";

const PIPELINE = [
  { name: "Research", text: "Wonder studies your market, competitors and audiences, with citations." },
  { name: "Concepts", text: "Spark proposes three or more genuinely different angles." },
  { name: "Storyboard", text: "Scenes, scripts and on-screen text using only verified claims." },
  { name: "Assets", text: "Your real screenshots and recordings, plus licensed or generated media." },
  { name: "Composition", text: "An editable timeline of scenes and layers, not a flat file." },
  { name: "Render", text: "HyperFrames and FFmpeg produce the actual MP4s and stills." },
  { name: "Review", text: "You approve, edit by conversation, and export to post." },
];

const MODELS = [
  { name: "Muse Wonder", role: "Plans the growth strategy, coordinates research with web search, and orchestrates campaigns and experiments." },
  { name: "Muse Spark 1.3", role: "Reads your listing and screenshots, finds positioning and audiences, writes concepts, scripts and storyboards, and makes scene-level edits." },
  { name: "SAM 3.1", role: "Segments and tracks you or objects in real footage so you can appear in front of your app." },
  { name: "Muse Voice Transcribe", role: "Turns founder recordings and spoken instructions into briefs, edits and captions." },
  { name: "Muse Image", role: "Campaign imagery where Meta permits access. Elsewhere a separately licensed image provider is used, and every image says which." },
  { name: "Muse Glimmer", role: "Self-hosted memory of your brand preferences and past decisions, so each campaign learns from the last." },
];

const PRINCIPLES = [
  { title: "Sourced, not invented", text: "Research findings carry the link and retrieval date. If a source can’t be found, there’s no finding." },
  { title: "Claims you’ve verified", text: "Creative only states what your App DNA evidence supports and you’ve approved." },
  { title: "Edits stay where you put them", text: "Changing one scene changes that scene. Everything else stays byte-for-byte the same." },
  { title: "You hold the publish button", text: "Posting and outreach wait for your explicit approval. Unconnected platforms get an export, never a fake “posted”." },
];

export default function Landing() {
  return (
    <div className="min-h-dvh bg-canvas">
      <header className="sticky top-0 z-30 border-b border-transparent bg-white/75 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-[1120px] items-center justify-between px-5">
          <Link href="/" aria-label="MuseLaunch home" className="rounded-md">
            <Logo />
          </Link>
          <NavAuthButtons />
        </div>
      </header>

      <main>
        {/* Hero */}
        <section className="mx-auto flex max-w-[1120px] flex-col items-center px-5 pb-24 pt-16 text-center sm:pt-24 md:pb-32 md:pt-32">
          <p className="mb-6 animate-rise-in text-body-sm font-medium text-ink-2">The AI growth studio for indie app developers</p>
          <h1 className="max-w-[15ch] animate-rise-in text-[44px] font-semibold leading-[1.02] tracking-[-0.038em] text-balance [animation-delay:60ms] sm:text-[60px] md:text-hero">
            Build your app. MuseLaunch helps the world discover it.
          </h1>
          <p className="mt-7 max-w-[58ch] animate-rise-in text-headline font-normal text-ink-2 text-pretty [animation-delay:120ms]">
            Paste your store link. Muse learns your product, researches your market, and produces campaigns with real, editable videos, all traced back to evidence you can check.
          </p>
          <div className="mt-10 w-full max-w-[560px] animate-rise-in [animation-delay:180ms]">
            <HeroLinkForm />
          </div>
        </section>

        {/* Pipeline (a real sequence) */}
        <section aria-labelledby="pipeline-title" className="border-t border-line bg-mist/50">
          <div className="mx-auto max-w-[1120px] px-5 py-20 md:py-28">
            <div className="mb-14 max-w-2xl">
              <h2 id="pipeline-title" className="text-title-1 font-semibold text-balance md:text-display">
                From a link to finished videos, in seven steps you can see.
              </h2>
              <p className="mt-4 text-headline font-normal text-ink-2">Every step runs as a background job with live progress. Stop it, retry it, or edit what it made.</p>
            </div>
            <ol className="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-7 lg:gap-x-4">
              {PIPELINE.map((s, i) => (
                <li key={s.name} className="relative lg:pt-10">
                  <div className="mb-3 flex items-center gap-3 lg:absolute lg:inset-x-0 lg:top-0 lg:mb-0">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-caption font-semibold tabular text-white">{i + 1}</span>
                    {i < PIPELINE.length - 1 ? <span aria-hidden className="hidden h-px flex-1 bg-line-strong lg:block" /> : null}
                  </div>
                  <p className="text-body font-semibold">{s.name}</p>
                  <p className="mt-1 text-body-sm text-ink-2 text-pretty">{s.text}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* Three tabs */}
        <section aria-labelledby="tabs-title" className="mx-auto max-w-[1120px] px-5 py-24 md:py-32">
          <div className="mx-auto mb-12 max-w-2xl text-center">
            <h2 id="tabs-title" className="text-title-1 font-semibold text-balance md:text-display">
              Three tabs. A whole growth team.
            </h2>
            <p className="mt-4 text-headline font-normal text-ink-2">Discover what to say, create it in Creator, and learn from it in Insights. That’s the whole app.</p>
          </div>
          <TabsShowcase />
        </section>

        {/* Principles */}
        <section aria-labelledby="principles-title" className="border-y border-line">
          <div className="mx-auto grid max-w-[1120px] gap-12 px-5 py-20 md:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] md:py-28">
            <h2 id="principles-title" className="text-title-1 font-semibold text-balance">
              Marketing you can stand behind.
            </h2>
            <dl className="grid gap-x-10 gap-y-8 sm:grid-cols-2">
              {PRINCIPLES.map((p) => (
                <div key={p.title} className="border-t border-ink pt-4">
                  <dt className="text-body font-semibold">{p.title}</dt>
                  <dd className="mt-1.5 text-body-sm text-ink-2 text-pretty">{p.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* Models */}
        <section aria-labelledby="models-title" className="mx-auto max-w-[1120px] px-5 py-24 md:py-32">
          <div className="mb-12 max-w-2xl">
            <h2 id="models-title" className="text-title-1 font-semibold text-balance md:text-display">
              Powered by Meta’s models, each doing the job it’s best at.
            </h2>
            <p className="mt-4 text-headline font-normal text-ink-2">Which providers are live for your account, and where a licensed alternative is used instead, is shown in Integrations after you sign in.</p>
          </div>
          <ul className="divide-y divide-line border-y border-line">
            {MODELS.map((m) => (
              <li key={m.name} className="grid gap-1 py-5 md:grid-cols-[minmax(0,3fr)_minmax(0,8fr)] md:gap-8">
                <p className="text-headline font-semibold">{m.name}</p>
                <p className="text-body text-ink-2 text-pretty">{m.role}</p>
              </li>
            ))}
            <li className="grid gap-1 py-5 md:grid-cols-[minmax(0,3fr)_minmax(0,8fr)] md:gap-8">
              <p className="text-headline font-semibold">HyperFrames + FFmpeg</p>
              <p className="text-body text-ink-2 text-pretty">Render the compositions into real video files you can download.</p>
            </li>
          </ul>
        </section>

        {/* Sample campaign: honest placeholder until a real render exists */}
        <section aria-labelledby="sample-title" className="bg-mist/60">
          <div className="mx-auto grid max-w-[1120px] items-center gap-12 px-5 py-24 md:grid-cols-2 md:py-28">
            <div className="space-y-4">
              <h2 id="sample-title" className="text-title-1 font-semibold text-balance">
                A sample campaign, made start to finish by MuseLaunch.
              </h2>
              <p className="text-headline font-normal text-ink-2 text-pretty">
                We’ll publish a real campaign here, rendered from an actual app’s listing, with its research sources and edit history. Until it exists, this space stays empty rather than showing a mock-up.
              </p>
            </div>
            <div className="mx-auto flex aspect-[9/16] w-full max-w-[300px] flex-col items-center justify-center gap-3 rounded-[36px] border border-dashed border-line-strong bg-surface p-8 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-mist text-ink-2">
                <Film className="size-5" aria-hidden />
              </span>
              <p className="text-body-sm font-medium">Sample video not published yet</p>
              <p className="text-footnote text-ink-2">It will play here once rendered.</p>
            </div>
          </div>
        </section>

        {/* Closing CTA */}
        <section className="mx-auto max-w-[1120px] px-5 py-24 text-center md:py-32">
          <h2 className="mx-auto max-w-[18ch] text-title-1 font-semibold text-balance md:text-display">You built something good. Let’s get it seen.</h2>
          <div className="mt-8 flex justify-center">
            <Link href="/login?next=%2Fonboarding" className="inline-flex h-12 items-center rounded-full bg-accent px-6 text-body font-medium text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:shadow-focus">
              Start with free beta credits
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-line">
        <div className="mx-auto flex max-w-[1120px] flex-col gap-3 px-5 py-8 text-footnote text-ink-2 sm:flex-row sm:items-center sm:justify-between">
          <Logo size={20} className="[&>span:last-child]:text-body-sm" />
          <p>Built for the Meta Global AI Developer Hackathon, 2026.</p>
        </div>
      </footer>
    </div>
  );
}
