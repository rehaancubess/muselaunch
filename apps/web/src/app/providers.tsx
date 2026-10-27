"use client";
import { ToastProvider, TooltipProvider } from "@muselaunch/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { AuthProvider } from "@/lib/auth/auth-provider";
import { makeQueryClient } from "@/lib/query";

export function Providers({ children }: { children: ReactNode }) {
  const [qc] = useState(makeQueryClient);
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <TooltipProvider>
          <ToastProvider>{children}</ToastProvider>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
