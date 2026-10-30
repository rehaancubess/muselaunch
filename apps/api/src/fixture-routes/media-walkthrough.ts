import type { FixtureModule } from "./_types";

/**
 * Fixture answers for module D's Muse Spark calls on real product media:
 * - `ScreenshotKinds` (media.extract_ui): follows the pixel hint the job sends with each image
 *   ("…device frame…" → marketing). In fixture mode the sample listing's third screenshot is a designed
 *   store image (fixtures/render/screenshot-marketing.png), so SAM then cuts its screen out.
 * - `RecordingShotLabels` (media.analyze_recording): labels every shot listed, cycling through the App DNA
 *   feature ids present in the request. Labels are prefixed "Fixture:"; nothing is invented beyond the request.
 */
const mod: FixtureModule = (h) => ({
  meta: [
    h.jsonRoute("ScreenshotKinds", (req) => ({
      images: [...h.requestText(req).matchAll(/^Image \d+: asset (\S+) .* Heuristic: (.*)$/gm)].map((m) => {
        const marketing = /device frame/.test(m[2]!);
        return { assetId: m[1], kind: marketing ? "marketing" : "raw_ui", reason: marketing ? "Fixture: headline and a drawn phone around the UI" : "Fixture: edge-to-edge app screen" };
      }),
    })),
    h.jsonRoute("RecordingShotLabels", (req) => {
      const text = h.requestText(req);
      const features = [...text.matchAll(/^(feat_[A-Za-z0-9_-]+): (.+?) —/gm)].map((m) => ({ id: m[1]!, name: m[2]! }));
      const shots = [...text.matchAll(/^Shot (\d+) · (.*)$/gm)].map((m) => ({ n: Number(m[1]), motion: /continuous motion/.test(m[2]!) }));
      return {
        shots: shots.map((s, i) => {
          const f = features.length ? features[i % features.length] : undefined;
          return {
            shot: s.n,
            label: f ? `Fixture: shows ${f.name}` : `Fixture: app screen ${s.n + 1}`,
            screen: f?.name ?? "App",
            action: s.motion ? "scroll" : i === 0 ? "navigate" : "tap",
            featureIds: f ? [f.id] : [],
            quality: i === 0 ? 0.5 : 0.8,
            privacy: { flagged: false, regions: [] },
          };
        }),
      };
    }),
  ],
});
export default mod;
