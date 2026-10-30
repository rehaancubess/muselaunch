import type { TemplateId } from "@muselaunch/contracts";

export type TemplateNeed = "screenshot" | "app_recording" | "founder_cutout" | "image" | "video" | "logo" | "none";

export interface TemplateInfo {
  label: string;
  description: string;
  /** Storyboard scene purposes this template suits (ScenePurpose values). */
  purposes: string[];
  /** Media the template wants, in order of preference. */
  needs: TemplateNeed[];
}

/**
 * The allowlisted scene templates. Storyboards (module B) must pick from these ids; the
 * compiler renders each with our own components. Every template keeps its layers editable.
 */
export const TEMPLATE_CATALOG: Record<TemplateId, TemplateInfo> = {
  "hook-title": {
    label: "Hook title",
    description: "Large kinetic headline (word-by-word reveal) on a soft brand gradient, optional small eyebrow line and background media. Best in the first 1–3 seconds.",
    purposes: ["hook", "problem", "transition"],
    needs: ["none", "image", "video"],
  },
  "device-demo": {
    label: "Device demo",
    description: "A real screenshot or screen recording inside an animated phone/tablet/browser frame with a soft shadow, gentle float and a headline above.",
    purposes: ["demo", "feature", "hook"],
    needs: ["app_recording", "screenshot"],
  },
  "feature-callout": {
    label: "Feature callout",
    description: "Real screenshot in a device frame offset to one side, with 1–3 animated callout chips pointing out what the user sees.",
    purposes: ["feature", "demo"],
    needs: ["screenshot", "app_recording"],
  },
  "founder-cutout": {
    label: "Founder cutout",
    description: "The founder (SAM cutout of their recording) in front of the app demo or a brand backdrop, with a lower-third name label. Falls back to unmasked footage.",
    purposes: ["founder", "hook", "problem"],
    needs: ["founder_cutout", "screenshot", "app_recording"],
  },
  "before-after": {
    label: "Before / after",
    description: "Two real workflow states side by side with labels and a wipe. Only for real states of the product or the user's actual workflow.",
    purposes: ["problem", "demo", "proof"],
    needs: ["screenshot", "screenshot"],
  },
  "text-over-media": {
    label: "Text over media",
    description: "Full-bleed image or video (stock, generated or uploaded; never depicting the app UI) with a slow zoom and a headline on a legible scrim.",
    purposes: ["hook", "problem", "transition", "other"],
    needs: ["video", "image"],
  },
  "split-screen": {
    label: "Split screen",
    description: "Two media panes stacked (vertical) or side by side (landscape) with short labels.",
    purposes: ["demo", "feature", "problem", "other"],
    needs: ["screenshot", "image"],
  },
  "quote-proof": {
    label: "Quote proof",
    description: "A REAL review or press quote with its source label. Must reference a verified claim; never invented.",
    purposes: ["proof"],
    needs: ["none"],
  },
  "stat-card": {
    label: "Stat card",
    description: "One REAL measured number (big) with a label and source line. Must reference a verified claim; never invented.",
    purposes: ["proof"],
    needs: ["none"],
  },
  "cta-endcard": {
    label: "CTA end card",
    description: "App icon/logo, app name, call to action and text store pills on a clean brand background.",
    purposes: ["cta"],
    needs: ["logo"],
  },
  "carousel-slide": {
    label: "Carousel slide",
    description: "Static slide for carousels, static ads and thumbnails: headline, short body and an optional real screenshot in a device frame.",
    purposes: ["hook", "feature", "demo", "proof", "cta", "other"],
    needs: ["screenshot", "none"],
  },
  "presenter-depth": {
    label: "Presenter in front of the app",
    description: "SAM cutout of the presenter in front, the real app demo and motion graphics behind them (depth layering).",
    purposes: ["founder", "demo", "hook"],
    needs: ["founder_cutout", "app_recording"],
  },
  "object-spotlight": {
    label: "Spotlight a real object",
    description: "A tracked real object (e.g. the phone in hand) is highlighted; callouts anchored to it follow it through the shot.",
    purposes: ["demo", "feature"],
    needs: ["video"],
  },
  "product-in-hand": {
    label: "App on the phone in hand",
    description: "The real app recording is placed onto the tracked phone the presenter is holding.",
    purposes: ["demo", "founder"],
    needs: ["video", "app_recording"],
  },
  "focus-zoom": {
    label: "Focus zoom",
    description: "Close-up: the real screen in a device frame, then a smooth push-in on one region (a button, a list, a result) with a soft highlight ring. Give `focus` {x,y,w,h} as fractions of the image you see (or a short `focusQuery`).",
    purposes: ["demo", "feature"],
    needs: ["screenshot", "app_recording"],
  },
  "tap-demo": {
    label: "Tap demo",
    description: "The real screen in a device frame with a finger dot and tap ripple on the control being used (the centre of `focus`). Shows the action, not just the screen.",
    purposes: ["demo", "feature"],
    needs: ["app_recording", "screenshot"],
  },
  "phone-tilt": {
    label: "Phone tilt",
    description: "Wide hero shot: the real screen in a device that turns in 3D over a parallax brand background, with a short headline. Good after the hook or to introduce a feature.",
    purposes: ["demo", "feature", "hook", "transition"],
    needs: ["screenshot", "app_recording"],
  },
  "kinetic-type": {
    label: "Kinetic type",
    description: "Punchy typography only: 2–8 words appear word by word at a readable pace, big and bold. For the problem, a turn in the story or a short benefit line.",
    purposes: ["hook", "problem", "transition", "feature", "other"],
    needs: ["none"],
  },
  "icon-reveal": {
    label: "Icon reveal",
    description: "The real app icon scales in with a soft glow and the app name. A brand beat (introduce the app after the problem, or before the CTA).",
    purposes: ["transition", "cta", "other"],
    needs: ["logo"],
  },
  "store-cta": {
    label: "Store CTA",
    description: "End card: app icon, name, the call to action and plain-text pills \"Download on the App Store\" / \"Get it on Google Play\" (no store logos).",
    purposes: ["cta"],
    needs: ["logo"],
  },
  "fullscreen-showcase": {
    label: "Full-screen showcase",
    description: "A designed marketing screenshot (it already has its own frame and headline) shown full screen with a slow push. The ONLY template for marketing screenshots; never inside a device.",
    purposes: ["demo", "feature", "proof", "other"],
    needs: ["screenshot"],
  },
};

/** Shot size, used to vary pacing like an editor (wide device shots, close-ups, type, full-bleed). */
export type ShotSize = "wide" | "close" | "text" | "full" | "presenter";

export const TEMPLATE_SHOT: Record<TemplateId, ShotSize> = {
  "hook-title": "text",
  "device-demo": "wide",
  "feature-callout": "wide",
  "founder-cutout": "presenter",
  "before-after": "wide",
  "text-over-media": "full",
  "split-screen": "wide",
  "quote-proof": "text",
  "stat-card": "text",
  "cta-endcard": "text",
  "carousel-slide": "wide",
  "presenter-depth": "presenter",
  "object-spotlight": "presenter",
  "product-in-hand": "presenter",
  "focus-zoom": "close",
  "tap-demo": "close",
  "phone-tilt": "wide",
  "kinetic-type": "text",
  "icon-reveal": "text",
  "store-cta": "text",
  "fullscreen-showcase": "full",
};

/** Templates that put product media inside a device frame (raw screenshots, SAM cut-outs, recordings only). */
export const DEVICE_TEMPLATES = new Set<TemplateId>(["device-demo", "feature-callout", "before-after", "split-screen", "carousel-slide", "focus-zoom", "tap-demo", "phone-tilt", "founder-cutout", "presenter-depth"]);

/** Templates that show the real app (need a screenshot, cut-out, recording segment or marketing screenshot). */
export const PRODUCT_SCENE_TEMPLATES = new Set<TemplateId>(["device-demo", "feature-callout", "before-after", "focus-zoom", "tap-demo", "phone-tilt", "fullscreen-showcase"]);

/** End cards. */
export const CTA_TEMPLATES = new Set<TemplateId>(["cta-endcard", "store-cta"]);
