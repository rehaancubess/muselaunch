import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // Workspace packages are consumed as TypeScript source.
  transpilePackages: ["@muselaunch/ui", "@muselaunch/contracts"],
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  poweredByHeader: false,
  typescript: { ignoreBuildErrors: false },
  images: { unoptimized: true },
  devIndicators: false,
};

export default config;
