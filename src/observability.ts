type LogLevel = "info" | "warn" | "error";

type OperationLogger = {
  info(event: string, details?: Record<string, unknown>): void;
  warn(event: string, details?: Record<string, unknown>): void;
  error(event: string, details?: Record<string, unknown>): void;
  step<T>(name: string, operation: () => Promise<T>, details?: Record<string, unknown>): Promise<T>;
};

export function createOperationLogger(operation: string): OperationLogger {
  return {
    info(event, details) {
      writeLog("info", operation, event, details);
    },
    warn(event, details) {
      writeLog("warn", operation, event, details);
    },
    error(event, details) {
      writeLog("error", operation, event, details);
    },
    async step(name, operationBody, details) {
      const started = Date.now();
      writeLog("info", operation, `${name}:start`, details);
      try {
        const result = await operationBody();
        writeLog("info", operation, `${name}:success`, {
          ...details,
          durationMs: Date.now() - started
        });
        return result;
      } catch (error) {
        writeLog("error", operation, `${name}:failure`, {
          ...details,
          durationMs: Date.now() - started,
          message: errorMessage(error)
        });
        throw error;
      }
    }
  };
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        isSensitiveKey(key) ? "[redacted]" : sanitizeForLog(item)
      ])
    );
  }
  return value;
}

function writeLog(
  level: LogLevel,
  operation: string,
  event: string,
  details?: Record<string, unknown>
): void {
  const safeDetails = sanitizeForLog(details ?? {}) as Record<string, unknown>;
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    operation,
    event,
    ...safeDetails
  };
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function sanitizeText(value: string): string {
  return value
    .replaceAll(/token=[^&\s]+/gi, "token=[redacted]")
    .replaceAll(/bot[0-9]+:[A-Za-z0-9_-]+/g, "bot[redacted]");
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return (
    normalized === "cookie" ||
    normalized === "cookieheader" ||
    normalized === "authorization" ||
    normalized === "password" ||
    normalized === "secret" ||
    normalized === "token" ||
    normalized.endsWith("_token") ||
    normalized.endsWith("-token") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("api_key")
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

export type { OperationLogger };
