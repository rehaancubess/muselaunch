import { DEFAULT_CREDIT_PRICES as PRICE, DEFAULT_PLANS } from "@muselaunch/contracts";

/** Landing copy that's long enough to keep out of the layout. Everything here must stay true. */

export const BUILT_ON = ["Muse Wonder", "Muse Spark 1.3", "Muse Spark Open", "SAM 3.1", "Muse Voice Transcribe", "Muse Glimmer", "HyperFrames"] as const;

/** "Open weights" is said only of these two: Glimmer runs self-hosted, Spark Open on Baseten. */
export const OPEN_WEIGHTS_NOTE = "Muse Glimmer (self-hosted) and Muse Spark Open (on Baseten) run Meta’s open weights.";

export const STEPS = [
  {
    title: "Paste your link",
    text: "MuseLaunch reads your App Store or Google Play listing and screenshots, then builds your App DNA: features, audiences and the claims you can make, each backed by evidence.",
  },
  {
    title: "Autopilot does the marketing",
    text: "It researches audiences and trends with cited sources, picks one to test, writes the campaign, renders videos from your real app and checks everything against your brand.",
  },
  {
    title: "You approve and post",
    text: "Each post waits for your OK, with a tracked link attached. Then Autopilot measures what happened and proposes the next experiment.",
  },
] as const;

export const OBJECT_FRAMES = [
  { src: "/landing/oa-behind.webp", say: "Put the app behind me", text: "Your app plays between the background and you." },
  { src: "/landing/oa-in-hand.webp", say: "Put the app on my phone", text: "Your real app recording fills the screen in your hand." },
  { src: "/landing/oa-spotlight.webp", say: "Spotlight my phone", text: "The rest dims, and a label stays pinned to the phone." },
] as const;

export const VIDEO_POINTS = [
  { title: "Say it or type it", text: "Muse Voice Transcribe turns spoken direction into edits. “Make this look like an Apple commercial and give me three hooks” works." },
  { title: "One scene at a time", text: "Changing one scene leaves every other scene exactly as it was." },
  { title: "Real files", text: "HyperFrames renders MP4s in 9:16, 1:1, 16:9 and 4:5, from compositions you can keep editing." },
] as const;

export const AUTOPILOT_POINTS = [
  { title: "A hard budget", text: "The loop pauses and asks before it spends past the limit you set." },
  { title: "Cited decisions", text: "Every audience pick and hypothesis links to the research behind it." },
  { title: "Approval gates", text: "Final renders ask first by default. Posts always do." },
  { title: "Your call, any step", text: "Pause it, cancel it, or take over a step and do it yourself." },
] as const;

export const GUARDIAN_POINTS = [
  { title: "Unsupported claims", text: "Flags anything your App DNA evidence doesn’t back up." },
  { title: "Tone and wording", text: "Catches drift from your voice and words you’ve ruled out." },
  { title: "Traceable findings", text: "Each finding says which check raised it." },
  { title: "Fixes you review", text: "Suggested changes wait for you before they’re applied." },
] as const;

export const INSIGHT_POINTS = [
  { title: "Sourced metrics", text: "Each number shows where it came from and how it’s attributed." },
  { title: "Nothing estimated", text: "Missing data stays missing, with a note on how to measure it." },
  { title: "Correlation, labelled", text: "A change after a launch is never presented as proof the launch caused it." },
  { title: "What to try next", text: "Muse compares experiments and recommends the next one to run." },
] as const;

export const CONTROL = [
  { title: "You approve every post", text: "Nothing is published until you approve that exact version." },
  { title: "Do it yourself, any time", text: "Pause Autopilot, take over any step, and edit anything it made." },
  { title: "A source for every finding", text: "Research links to where it came from and when. No source, no finding." },
  { title: "Only claims you’ve verified", text: "Creative states what your App DNA supports and you’ve approved." },
  { title: "No fake “posted”", text: "Accounts you haven’t connected get an export and a checklist instead." },
  { title: "Costs shown first", text: "Every action shows its credit estimate before it runs." },
] as const;

const FREE = DEFAULT_PLANS.free;
export const FREE_CREDITS = FREE.monthlyCredits;

export const FREE_LIMITS = [
  `${FREE.limits.apps} apps and ${FREE.limits.members} teammates`,
  `Videos up to ${FREE.limits.maxVideoSec} seconds`,
  `${FREE.limits.finalRendersPerDay} final renders a day`,
  `${FREE.limits.researchRunsPerDay} research runs a day`,
] as const;

export const CREDIT_ROWS = [
  { label: "Import and analyse your app", credits: PRICE["app.import"] + PRICE["app.analyze"] },
  { label: "Market research run", credits: PRICE["research.run"] },
  { label: "Campaign concepts", credits: PRICE["campaign.generate_concepts"] },
  { label: "Storyboard", credits: PRICE["storyboard.generate"] },
  { label: "AI edit", credits: PRICE["composition.edit"] },
  { label: "Final render, per 15 seconds", credits: PRICE["render.final_per_15s"] },
  { label: "Brand Guardian review", credits: PRICE["brand.review"] },
  { label: "Analytics sync and imports", credits: PRICE["analytics.sync"] },
] as const;

/**
 * One Growth Autopilot round with two video variants and 15-second videos.
 * Mirrors estimateAutopilot() in @muselaunch/autopilot, using the default price list.
 */
const V = 2;
export const AUTOPILOT_ROUND_CREDITS =
  PRICE["research.run"] +
  PRICE["campaign.generate_concepts"] +
  V * (PRICE["storyboard.generate"] + PRICE["composition.build"] + PRICE["render.preview"]) +
  V * PRICE["brand.review"] +
  V * PRICE["render.final_per_15s"] +
  V * PRICE["video.review"] +
  V * PRICE["copy.generate"] +
  PRICE["experiment.analyze"] +
  PRICE["recommendations.generate"];

export const FAQ = [
  {
    q: "Do I need an App Store or Google Play listing?",
    a: "No. Leave the link empty and describe your app instead. You can add screenshots and screen recordings later, and MuseLaunch uses them as evidence.",
  },
  {
    q: "Will anything be posted without my approval?",
    a: "No. Every post waits for you to approve that exact version. For accounts you haven’t connected, you get a ready-to-post package and a checklist, and nothing is marked as posted until you say so.",
  },
  {
    q: "Can I do parts of it myself?",
    a: "Yes. Pause or cancel Growth Autopilot at any point, take over any step, and edit anything it made in the Studio. You can also run research and campaigns by hand from Discover and Creator.",
  },
  {
    q: "Where does the research come from?",
    a: "Muse Wonder searches the web live. Each finding links to its source and the date it was retrieved, and the AI’s interpretation is labelled separately from what the source says. If there’s no source, there’s no finding.",
  },
  {
    q: "Are the videos real files I can download?",
    a: "Yes. HyperFrames renders MP4s in 9:16, 1:1, 16:9 and 4:5 from editable compositions built with your real screens and footage. Download them one at a time, or as a posting package with captions.",
  },
  {
    q: "What does the Brand Guardian check?",
    a: "Every video, caption and post, against your verified claims, brand voice, words to avoid, and CTA and platform fit. It runs on a self-hosted Muse Glimmer model alongside deterministic rules, and each finding names the check that raised it.",
  },
  {
    q: "Which analytics can I connect?",
    a: "RevenueCat and supported social accounts, CSV imports for store and social analytics, and MuseLaunch tracked links for clicks. Imported numbers are labelled as imported, and Integrations shows what’s live on your account.",
  },
  {
    q: "Which AI models does MuseLaunch use?",
    a: "Meta’s Muse Wonder plans research and runs Growth Autopilot. Muse Spark 1.3 analyses your app and writes campaigns, scripts and edits. Muse Spark Open, Meta’s open-weights model on Baseten, writes post copy and variant briefs, and steps in when the Meta Model API is limited (each run shows which model did what). SAM 3.1 tracks people and objects in your footage. Muse Voice Transcribe handles recordings and spoken edits. A self-hosted Muse Glimmer model, also open weights, reviews brand fit and remembers your preferences. HyperFrames renders the videos.",
  },
] as const;
