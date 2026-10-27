"use client";
import { ToastProvider, TooltipProvider, UiLinkProvider, type UiLinkComponent } from "@muselaunch/ui";
import Link from "next/link";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { AuthProvider } from "@/lib/auth/auth-provider";
import { makeQueryClient } from "@/lib/query";
import { FixtureBanner } from "@/lib/runtime";

const NextLink: UiLinkComponent = ({ href, ...rest }) => <Link href={href} prefetch={false} {...rest} />;

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <TooltipProvider>
          <UiLinkProvider component={NextLink}>
            <ToastProvider>
              <FixtureBanner />
              {children}
            </ToastProvider>
          </UiLinkProvider>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
