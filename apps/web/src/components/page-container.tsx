import { cn } from "@muselaunch/ui";
import type { ReactNode } from "react";

/** Standard content column for app pages. `wide` for grids, `narrow` for forms. */
export function PageContainer({ children, className, width = "default" }: { children: ReactNode; className?: string; width?: "narrow" | "default" | "wide" | "full" }) {
  return (
    <div
      className={cn(
        "mx-auto w-full px-4 pb-28 pt-8 sm:px-6 md:pb-16 md:pt-10 lg:px-8",
        width === "narrow" && "max-w-2xl",
        width === "default" && "max-w-[1120px]",
        width === "wide" && "max-w-[1320px]",
        width === "full" && "max-w-none",
        className,
      )}
    >
      {children}
    </div>
  );
}
