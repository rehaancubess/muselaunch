import { getAuth } from "firebase-admin/auth";
import { getFirebaseApp } from "@muselaunch/db";
import type { Config } from "./config";
import { AppError } from "./errors";

export interface AuthUser {
  uid: string;
  email?: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
  /** Country hint from the edge (e.g. `X-Client-Country` set by a trusted proxy). */
  provider: "firebase" | "dev";
}

/**
 * Verify a bearer token. Firebase ID tokens in normal operation; `dev:<uid>:<email>` tokens
 * only when AUTH_DEV_TOKENS=1 and not in production (local runs and automated tests).
 */
export async function verifyBearer(cfg: Config, header: string | undefined): Promise<AuthUser> {
  if (!header?.startsWith("Bearer ")) throw new AppError("UNAUTHENTICATED", "Missing bearer token");
  const token = header.slice(7).trim();
  if (token.startsWith("dev:")) {
    if (cfg.NODE_ENV === "production" || !(cfg.AUTH_DEV_TOKENS || cfg.AUTH_MODE === "dev")) {
      throw new AppError("UNAUTHENTICATED", "Dev tokens are disabled");
    }
    const [, uid, email] = token.split(":");
    if (!uid || !/^[A-Za-z0-9_-]{3,64}$/.test(uid)) throw new AppError("UNAUTHENTICATED", "Bad dev token");
    return { uid, email: email || `${uid}@dev.local`, emailVerified: true, name: uid, provider: "dev" };
  }
  if (cfg.AUTH_MODE !== "firebase") throw new AppError("UNAUTHENTICATED", "Firebase auth disabled");
  try {
    const decoded = await getAuth(getFirebaseApp(cfg.FIREBASE_PROJECT_ID)).verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email,
      emailVerified: Boolean(decoded.email_verified),
      name: decoded.name as string | undefined,
      picture: decoded.picture,
      provider: "firebase",
    };
  } catch (err) {
    throw new AppError("UNAUTHENTICATED", "Invalid or expired session", { cause: err });
  }
}
