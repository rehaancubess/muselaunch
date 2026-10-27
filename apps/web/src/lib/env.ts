/** Public runtime configuration (inlined at build time by Next.js). */
export const env = {
  apiUrl: (process.env.NEXT_PUBLIC_API_URL || "http://localhost:8080").replace(/\/$/, ""),
  authMode: (process.env.NEXT_PUBLIC_AUTH_MODE === "firebase" ? "firebase" : "dev") as "firebase" | "dev",
  firebase: {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "",
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "",
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "",
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "",
  },
};

export const firebaseConfigured = Boolean(env.firebase.apiKey && env.firebase.authDomain && env.firebase.projectId);
