"use client";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { setTokenGetter, setUnauthenticatedHandler } from "../api";
import { env, firebaseConfigured } from "../env";

export interface SessionUser {
  uid: string;
  email?: string;
  name?: string;
  photoUrl?: string;
  provider: "firebase" | "dev";
}

export type AuthStatus = "loading" | "signed_out" | "signed_in";

export interface AuthApi {
  status: AuthStatus;
  user: SessionUser | null;
  mode: "firebase" | "dev";
  /** Firebase mode only: whether NEXT_PUBLIC_FIREBASE_* is set. */
  configured: boolean;
  signInWithGoogle: () => Promise<void>;
  sendEmailLink: (email: string, continuePath?: string) => Promise<void>;
  completeEmailLink: (href: string, email?: string) => Promise<"signed_in" | "needs_email" | "not_a_link">;
  /** Dev mode only: issues a `dev:<uid>:<email>` token (API must run with AUTH_DEV_TOKENS=1). */
  signInDev: (email: string, name?: string) => void;
  signOut: () => Promise<void>;
  getToken: () => Promise<string | null>;
}

const AuthCtx = createContext<AuthApi | null>(null);

export function useAuth(): AuthApi {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}

const DEV_KEY = "ml.devSession";
const EMAIL_KEY = "ml.emailForSignIn";

function readDevSession(): { token: string; user: SessionUser } | null {
  try {
    const raw = window.localStorage.getItem(DEV_KEY);
    return raw ? (JSON.parse(raw) as { token: string; user: SessionUser }) : null;
  } catch {
    return null;
  }
}

/** Derive a stable dev uid from an email (API accepts [A-Za-z0-9_-]{3,64}). */
function devUidFor(email: string) {
  const base = email
    .toLowerCase()
    .replace(/@.*/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .slice(0, 40);
  let h = 0;
  for (let i = 0; i < email.length; i++) h = (h * 33 + email.charCodeAt(i)) >>> 0;
  return `dev_${base || "user"}_${h.toString(36)}`.slice(0, 64);
}

type FirebaseAuthModule = typeof import("firebase/auth");
type FirebaseAuth = import("firebase/auth").Auth;

let firebaseAuthPromise: Promise<{ auth: FirebaseAuth; mod: FirebaseAuthModule }> | null = null;
function loadFirebase() {
  if (!firebaseAuthPromise) {
    firebaseAuthPromise = (async () => {
      const [{ initializeApp, getApps }, mod] = await Promise.all([import("firebase/app"), import("firebase/auth")]);
      const app = getApps()[0] ?? initializeApp(env.firebase);
      const auth = mod.getAuth(app);
      return { auth, mod };
    })();
  }
  return firebaseAuthPromise;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);
  const devToken = useRef<string | null>(null);
  const qc = useQueryClient();
  const mode = env.authMode;

  useEffect(() => {
    if (mode === "dev") {
      const s = readDevSession();
      devToken.current = s?.token ?? null;
      setUser(s?.user ?? null);
      setStatus(s ? "signed_in" : "signed_out");
      return;
    }
    if (!firebaseConfigured) {
      setStatus("signed_out");
      return;
    }
    let unsub: (() => void) | undefined;
    let alive = true;
    loadFirebase()
      .then(({ auth, mod }) => {
        if (!alive) return;
        unsub = mod.onIdTokenChanged(auth, (u) => {
          if (u) {
            setUser({ uid: u.uid, email: u.email ?? undefined, name: u.displayName ?? undefined, photoUrl: u.photoURL ?? undefined, provider: "firebase" });
            setStatus("signed_in");
          } else {
            setUser(null);
            setStatus("signed_out");
          }
        });
      })
      .catch(() => setStatus("signed_out"));
    return () => {
      alive = false;
      unsub?.();
    };
  }, [mode]);

  const getToken = useCallback(async () => {
    if (mode === "dev") return devToken.current;
    if (!firebaseConfigured) return null;
    const { auth } = await loadFirebase();
    return auth.currentUser ? auth.currentUser.getIdToken() : null;
  }, [mode]);

  const signOut = useCallback(async () => {
    if (mode === "dev") {
      try {
        window.localStorage.removeItem(DEV_KEY);
      } catch {
        /* storage unavailable */
      }
      devToken.current = null;
    } else if (firebaseConfigured) {
      const { auth, mod } = await loadFirebase();
      await mod.signOut(auth);
    }
    setUser(null);
    setStatus("signed_out");
    qc.clear();
  }, [mode, qc]);

  useEffect(() => {
    setTokenGetter(getToken);
  }, [getToken]);

  useEffect(() => {
    setUnauthenticatedHandler(() => {
      // A 401 with a dev token means the API restarted without dev tokens, or the Firebase session expired.
      if (mode === "firebase") void getToken();
    });
    return () => setUnauthenticatedHandler(null);
  }, [mode, getToken]);

  const api = useMemo<AuthApi>(
    () => ({
      status,
      user,
      mode,
      configured: mode === "dev" ? true : firebaseConfigured,
      getToken,
      signOut,
      signInDev: (email, name) => {
        const clean = email.trim().toLowerCase();
        const uid = devUidFor(clean);
        const token = `dev:${uid}:${clean}`;
        const u: SessionUser = { uid, email: clean, name: name?.trim() || undefined, provider: "dev" };
        try {
          window.localStorage.setItem(DEV_KEY, JSON.stringify({ token, user: u }));
        } catch {
          /* storage unavailable: session lasts for this tab only */
        }
        devToken.current = token;
        setUser(u);
        setStatus("signed_in");
      },
      signInWithGoogle: async () => {
        const { auth, mod } = await loadFirebase();
        await mod.signInWithPopup(auth, new mod.GoogleAuthProvider());
      },
      sendEmailLink: async (email, continuePath = "/login") => {
        const { auth, mod } = await loadFirebase();
        await mod.sendSignInLinkToEmail(auth, email, { url: `${window.location.origin}${continuePath}`, handleCodeInApp: true });
        try {
          window.localStorage.setItem(EMAIL_KEY, email);
        } catch {
          /* ignore */
        }
      },
      completeEmailLink: async (href, email) => {
        const { auth, mod } = await loadFirebase();
        if (!mod.isSignInWithEmailLink(auth, href)) return "not_a_link";
        let stored: string | null = null;
        try {
          stored = window.localStorage.getItem(EMAIL_KEY);
        } catch {
          /* ignore */
        }
        const addr = email ?? stored;
        if (!addr) return "needs_email";
        await mod.signInWithEmailLink(auth, addr, href);
        try {
          window.localStorage.removeItem(EMAIL_KEY);
        } catch {
          /* ignore */
        }
        return "signed_in";
      },
    }),
    [status, user, mode, getToken, signOut],
  );

  return <AuthCtx.Provider value={api}>{children}</AuthCtx.Provider>;
}
