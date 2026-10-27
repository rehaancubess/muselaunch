import "@fontsource-variable/inter/opsz.css";
import "./globals.css";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Providers } from "./providers";

export const metadata: Metadata = {
  title: { default: "MuseLaunch — the AI growth studio for indie apps", template: "%s · MuseLaunch" },
  description: "Build your app. MuseLaunch helps the world discover it. Research, campaigns, real videos and honest insights for indie developers.",
  applicationName: "MuseLaunch",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
  colorScheme: "light",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="bg-canvas">
      <body className="bg-canvas text-ink antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
