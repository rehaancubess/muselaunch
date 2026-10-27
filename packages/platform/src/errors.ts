import type { ErrorInfo } from "@muselaunch/contracts";
import { DbError } from "@muselaunch/db";
import { ZodError } from "zod";

export type ErrorCode =
  | "BAD_REQUEST"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "ALREADY_EXISTS"
  | "VALIDATION_FAILED"
  | "INSUFFICIENT_CREDITS"
  | "QUOTA_EXCEEDED"
  | "SPEND_CEILING"
  | "RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_RESTRICTED"
  | "PROVIDER_ERROR"
  | "BUDGET_EXHAUSTED"
  | "APPROVAL_REQUIRED"
  | "CANCELLED"
  | "TIMEOUT"
  | "UNSAFE_URL"
  | "INTERNAL";

const HTTP_STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 422,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  ALREADY_EXISTS: 409,
  INSUFFICIENT_CREDITS: 402,
  QUOTA_EXCEEDED: 429,
  SPEND_CEILING: 429,
  RATE_LIMITED: 429,
  PROVIDER_UNAVAILABLE: 503,
  PROVIDER_NOT_CONFIGURED: 503,
  PROVIDER_RESTRICTED: 451,
  PROVIDER_ERROR: 502,
  BUDGET_EXHAUSTED: 429,
  APPROVAL_REQUIRED: 409,
  CANCELLED: 409,
  TIMEOUT: 504,
  UNSAFE_URL: 400,
  INTERNAL: 500,
};

const USER_MESSAGES: Partial<Record<ErrorCode, string>> = {
  UNAUTHENTICATED: "Please sign in again.",
  FORBIDDEN: "You don't have permission to do that in this workspace.",
  NOT_FOUND: "We couldn't find that.",
  INSUFFICIENT_CREDITS: "You're out of credits for this action.",
  QUOTA_EXCEEDED: "You've reached your plan's limit for this. Try again later or upgrade.",
  SPEND_CEILING: "MuseLaunch has paused costly AI work to stay within its safety budget. Please try again later.",
  RATE_LIMITED: "Too many requests. Please slow down a little.",
  PROVIDER_UNAVAILABLE: "An AI service we rely on is temporarily unavailable. Please retry.",
  PROVIDER_NOT_CONFIGURED: "This feature isn't connected yet on this deployment.",
  PROVIDER_RESTRICTED: "This provider isn't available in your region; we use a licensed alternative instead.",
  PROVIDER_ERROR: "An AI service returned an error. Please retry.",
  TIMEOUT: "This took too long. Please retry.",
  UNSAFE_URL: "That link can't be imported.",
  INTERNAL: "Something went wrong on our side. Please retry.",
};

export class AppError extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly opts: { retryable?: boolean; userMessage?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = "AppError";
    this.status = HTTP_STATUS[code];
  }
  get retryable(): boolean {
    return this.opts.retryable ?? ["PROVIDER_UNAVAILABLE", "TIMEOUT", "RATE_LIMITED", "INTERNAL"].includes(this.code);
  }
  toInfo(): ErrorInfo {
    return {
      code: this.code,
      message: this.message,
      userMessage: this.opts.userMessage ?? USER_MESSAGES[this.code],
      retryable: this.retryable,
      details: this.opts.details,
    };
  }
}

export const errors = {
  badRequest: (m: string, details?: Record<string, unknown>) => new AppError("BAD_REQUEST", m, { details }),
  unauthenticated: (m = "Authentication required") => new AppError("UNAUTHENTICATED", m),
  forbidden: (m = "Forbidden") => new AppError("FORBIDDEN", m),
  notFound: (what: string) => new AppError("NOT_FOUND", `${what} not found`),
  conflict: (m: string) => new AppError("CONFLICT", m),
  providerNotConfigured: (provider: string) => new AppError("PROVIDER_NOT_CONFIGURED", `${provider} is not configured`, { userMessage: `${provider} isn't connected on this deployment yet.` }),
};

/** Normalise anything thrown into an AppError. */
export function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return new AppError("VALIDATION_FAILED", "Validation failed", {
      userMessage: "Some of the information provided isn't valid.",
      details: { issues: err.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) },
    });
  }
  if (err instanceof DbError) {
    const map: Record<DbError["code"], ErrorCode> = {
      NOT_FOUND: "NOT_FOUND",
      ALREADY_EXISTS: "ALREADY_EXISTS",
      CONFLICT: "CONFLICT",
      INVALID: "VALIDATION_FAILED",
      TX_READ_REQUIRED: "INTERNAL",
      MISSING_INDEX: "INTERNAL",
      FORBIDDEN_COLLECTION: "INTERNAL",
    };
    return new AppError(map[err.code], err.message, { cause: err });
  }
  if (err instanceof Error && err.name === "AbortError") return new AppError("CANCELLED", "Operation was cancelled", { cause: err });
  return new AppError("INTERNAL", err instanceof Error ? err.message : String(err), { cause: err });
}
