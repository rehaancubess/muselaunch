import { slidePlanRoute, textPostCopyRoute } from "@muselaunch/agents/testing";
import type { FixtureModule } from "./_types";

/**
 * FIXTURE MODE: Muse Spark's slide plans (schema "SlidePlan", packages/agents/src/slides.ts) for the
 * sample app (Tidy Timer), so `pnpm dev:fixture` can make a post, a carousel, a thumbnail or a store
 * screenshot set end to end, and its text-only posts (CopyPacks for a Create text post: one post per
 * channel within the channel's limit; other copy requests fall through to the built-in fixture).
 * The builders live in packages/agents/src/testing.ts (shared with the tests): labelled fixture copy
 * written for the sample app; every screen is a ref that appears in the request, proof slides only
 * cite a verified claim id from the request, and the slide count follows the request. NOT live output.
 */
const mod: FixtureModule = () => ({ meta: [textPostCopyRoute(), slidePlanRoute()] });
export default mod;
