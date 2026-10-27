/**
 * Runtime resources the compiler inlines into HyperFrames HTML. The package stays pure
 * (no fs), so Node callers register them once via `@muselaunch/compositions/node`
 * (`ensureNodeCompileRuntime()`), and browser callers may register their own.
 */
export interface CompileRuntime {
  /** GSAP minified source for `gsapSource: "inline"`. */
  gsap?: string;
  /** `@font-face` CSS for the bundled fonts (data URLs; deterministic, no network). */
  fontCss?: string;
}

let current: CompileRuntime = {};

export function registerCompileRuntime(r: CompileRuntime): void {
  current = { ...current, ...r };
}

export function getCompileRuntime(): Readonly<CompileRuntime> {
  return current;
}
