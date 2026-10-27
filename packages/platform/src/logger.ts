import { pino, type Logger } from "pino";

export type { Logger };

/** Structured JSON logs (Cloud Logging-compatible `severity`), with secrets redacted. */
export function createLogger(opts: { level?: string; name?: string } = {}): Logger {
  return pino({
    name: opts.name ?? "muselaunch",
    level: opts.level ?? process.env.LOG_LEVEL ?? "info",
    messageKey: "message",
    formatters: {
      level(label) {
        const severity = { trace: "DEBUG", debug: "DEBUG", info: "INFO", warn: "WARNING", error: "ERROR", fatal: "CRITICAL" }[label] ?? "DEFAULT";
        return { severity, level: label };
      },
    },
    redact: {
      paths: [
        "req.headers.authorization",
        "headers.authorization",
        "authorization",
        "apiKey",
        "*.apiKey",
        "token",
        "*.token",
        "accessToken",
        "*.accessToken",
        "refreshToken",
        "*.refreshToken",
        "secret",
        "*.secret",
      ],
      censor: "[redacted]",
    },
  });
}

let root: Logger | undefined;
export function logger(): Logger {
  root ??= createLogger();
  return root;
}
