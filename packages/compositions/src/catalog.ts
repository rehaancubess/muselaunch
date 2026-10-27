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
};
