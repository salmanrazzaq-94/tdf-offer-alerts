export type Env = {
  TDF_ALERTS: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  COOKIE_FORM_TOKEN: string;
  GITHUB_REFRESH_TOKEN?: string;
  GITHUB_REPOSITORY?: string;
  GITHUB_REFRESH_REF?: string;
};

export type TelegramUpdate = {
  message?: {
    text?: string;
    chat: {
      id: number;
    };
  };
};

type TdfPerformance = {
  performanceId: number;
  performanceDate: string;
};

export type TdfOffer = {
  productionSeasonId: number;
  title: string;
  facility: string;
  thumbnail?: string;
  performances: TdfPerformance[];
};

export type TdfFetchResult = {
  offers: TdfOffer[];
  cookie: string;
};

export type AlertItem = {
  id: string;
  title: string;
  facility: string;
  performanceDate: string;
};

export type RunStep = {
  name: string;
  status: "success" | "failure" | "skipped";
  at: string;
  durationMs?: number;
  details?: Record<string, unknown>;
};

export type RunLog = {
  id: string;
  event: "delta" | "daily" | "command" | "cookie" | "status" | "verify" | "refresh";
  status: "success" | "failure" | "skipped";
  trigger: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  version: string;
  shows?: number;
  performances?: number;
  newPerformances?: number;
  notificationSent?: boolean;
  failureKind?: "auth" | "transient" | "unexpected";
  message?: string;
  steps: RunStep[];
  schemaVersion?: number;
  sourceRunId?: string;
  externalRunUrl?: string;
  environment?: string;
};

export type AuthState = {
  lastFailureNotifiedAt: string | null;
  lastFailureKind: string | null;
  lastFailureReason: string | null;
  lastRefreshAttemptedAt: string | null;
  lastRefreshAttemptStatus: BrowserbaseRefreshResult["status"] | null;
};

export type CookieMeta = {
  savedAt: string | null;
  source: string | null;
  cookieBytes: number;
  hasSessionCookie: boolean;
  hasTnewCookie: boolean;
  sourceRunId?: string;
  externalRunUrl?: string;
  browserbaseSessionId?: string;
};

export type CookieSaveMetadata = {
  sourceRunId?: string;
  externalRunUrl?: string;
  browserbaseSessionId?: string;
};

export type HealthState = {
  lastStaleNotifiedAt: string | null;
  lastDeltaSuccessAt: string | null;
};

export type BrowserbaseRefreshResult = {
  status: "started" | "throttled" | "not-auth" | "not-configured" | "dispatch-failed";
  attemptedAt?: string;
  failureReason?: string;
};

export type DebugSnapshot = {
  version: string;
  generatedAt: string;
  cookie: CookieMeta;
  auth: AuthState;
  health: HealthState;
};
