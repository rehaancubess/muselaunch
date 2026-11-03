import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@muselaunch/ui", "@muselaunch/contracts"],
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // Trace from the monorepo root so the standalone server includes workspace packages.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  images: { unoptimized: true },
  devIndicators: false,
  // The notifications service worker (public/sw.js): always fetched fresh, so a fix reaches every browser.
  headers: async () => [
    {
      source: "/sw.js",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Content-Type", value: "application/javascript; charset=utf-8" },
      ],
    },
  ],
};

export default config;
