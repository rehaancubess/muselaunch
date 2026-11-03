import { createContext, useContext, type ReactNode } from "react";
import { MONOCHROME, themeFor, type Accent } from "../lib/app-theme";
import { useSession } from "../session";

const AccentContext = createContext<Accent>(MONOCHROME);

/** The open app's accent shades (monochrome when no app is open or it has no colour). */
export const useAccent = () => useContext(AccentContext);

export function AccentProvider({ children }: { children: ReactNode }) {
  const { app } = useSession();
  return <AccentContext.Provider value={themeFor(app)}>{children}</AccentContext.Provider>;
}
