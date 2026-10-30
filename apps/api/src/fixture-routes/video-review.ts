import type { FixtureModule } from "./_types";

/**
 * Spark video review (Track 4) in fixture mode: answers the multimodal "VideoReview" call with an
 * honest, labelled result that names only scene ids present in the request. The frames are real
 * (FFmpeg on the real render) and the deterministic measurements (reading speed, blank frames,
 * repeated screenshots, phone-in-phone) still run, so real problems in the render are still caught.
 */
const videoReview: FixtureModule = (h) => ({
  meta: [
    h.jsonRoute("VideoReview", (req) => {
      const text = h.requestText(req);
      const scenes = [...text.matchAll(/^- (\S+) \| ([^|]+) \| template/gm)].map((m) => ({ id: m[1]!, name: m[2]!.trim() }));
      const frames = [...text.matchAll(/^Frame (f\d+):/gm)].map((m) => m[1]!);
      const last = scenes.at(-1);
      return {
        score: 7,
        summary: "Fixture: this review comes from a test fixture, not Muse Spark. Only the measured findings reflect the real render.",
        rubric: [
          { check: "hook_readability", verdict: "unclear", note: "Fixture: not judged" },
          { check: "honesty", verdict: "unclear", note: "Fixture: not judged" },
        ],
        findings: last
          ? [
              {
                sceneId: last.id,
                severity: "info",
                check: "cta",
                issue: `Fixture: check that the call to action in “${last.name}” stays on screen long enough to read.`,
                fixInstruction: "Keep the call to action on screen for at least 1.5 seconds.",
                frameRef: frames.at(-1) ?? "",
              },
            ]
          : [],
      };
    }),
  ],
});

export default videoReview;
