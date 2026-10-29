import type { FixtureModule } from "./_types";

/**
 * YouTube channel analysis (module F) in fixture mode. The YouTube Data API itself is NOT faked here:
 * without YOUTUBE_API_KEY the feature says "not set up"; with a real key the numbers are real. Only
 * the text-model interpretation is answered, with a labelled "Fixture:" reading that contains no
 * numbers (so nothing invented can pass the number grounding).
 */
const youtube: FixtureModule = (h) => ({
  meta: [
    h.jsonRoute("YouTubeChannelInterpretation", () => ({
      summary: "Fixture: a test fixture wrote this reading, not a model. Compare the length groups and title patterns above before deciding what to test.",
      findingNotes: [],
      hooksToTest: [],
      formatsToTest: [],
      cautions: ["Fixture: lifetime view counts favour older uploads."],
    })),
  ],
});

export default youtube;
