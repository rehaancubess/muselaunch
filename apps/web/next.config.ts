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
};

export default config;
