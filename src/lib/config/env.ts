import "server-only";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { MAX_QUESTIONS_LIMIT, type ProviderMode } from "@/lib/contracts";
import { AppError } from "@/lib/validation/errors";

/**
 * The single place that reads process.env. Services receive an AppConfig
 * object instead of reading the environment themselves.
 */

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true"));

const int = (fallback: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v : undefined));

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  QLOO_MODE: z.enum(["mock", "live"]).default("mock"),
  QLOO_API_KEY: optionalString,
  QLOO_BASE_URL: optionalString,
  QLOO_TIMEOUT_MS: int(8000, 100, 60_000),

  // `google` is canonical; `gemini` is a legacy alias; `none` explicitly disables inference in live mode.
  LLM_PROVIDER: z.string().default("google"),
  LLM_MODEL: optionalString,
  GOOGLE_API_KEY: optionalString,
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  LLM_TIMEOUT_MS: int(15_000, 100, 120_000),
  QUESTION_GENERATION_MODE: z.enum(["deterministic", "llm_grounded"]).default("deterministic"),

  SESSION_SIGNING_SECRET: optionalString,
  SESSION_TTL_SECONDS: int(1800, 60, 86_400),
  SESSION_STORE: z.enum(["memory", "redis"]).optional(),
  UPSTASH_REDIS_REST_URL: optionalString,
  UPSTASH_REDIS_REST_TOKEN: optionalString,

  MAX_QUESTIONS: int(MAX_QUESTIONS_LIMIT, 1, MAX_QUESTIONS_LIMIT),
  MAX_QLOO_CALLS_PER_SESSION: int(6, 1, 50),
  MAX_AGENT_TOOL_CALLS_PER_TURN: int(3, 1, 10),
  MAX_RECOMMENDATION_CANDIDATES: int(30, 2, 50),
  FINAL_RECOMMENDATION_COUNT: int(5, 1, 5),

  ENABLE_ADAPTIVE_QUESTIONING: bool(true),
  ENABLE_EARLY_STOPPING: bool(true),
  ENABLE_QLOO_CACHE: bool(false),
  CACHE_TTL_SECONDS: int(3600, 0, 604_800),
  ENABLE_EVALUATION_LOGGING: bool(false),
  ENABLE_AGENT_TRACING: bool(false),
  SENTRY_DSN: optionalString,
});

export type AppConfig = {
  nodeEnv: "development" | "production" | "test";
  mode: ProviderMode;
  qloo: { apiKey?: string; baseUrl?: string; timeoutMs: number };
  llm: { provider: string; model?: string; apiKey?: string; temperature: number; timeoutMs: number };
  session: { signingSecret: string; ttlSeconds: number; secretIsEphemeral: boolean };
  sessionStore: { kind: "memory" } | { kind: "redis"; url: string; token: string };
  limits: {
    maxQuestions: number;
    maxQlooCallsPerSession: number;
    maxAgentToolCallsPerTurn: number;
    maxRecommendationCandidates: number;
    finalRecommendationCount: number;
  };
  features: {
    questionGenerationMode: "deterministic" | "llm_grounded";
    adaptiveQuestioning: boolean;
    earlyStopping: boolean;
    qlooCache: boolean;
    cacheTtlSeconds: number;
    evaluationLogging: boolean;
    agentTracing: boolean;
  };
  sentryDsn?: string;
};

export const MIN_SECRET_LENGTH = 32;

type EnvSource = Record<string, string | undefined>;

const EPHEMERAL_KEY = Symbol.for("tasteprobe.ephemeralSessionSecret");

/** Random per-process secret, only for local mock development without a configured secret. */
function ephemeralDevSecret(): string {
  const store = globalThis as unknown as Record<symbol, string | undefined>;
  if (!store[EPHEMERAL_KEY]) {
    store[EPHEMERAL_KEY] = randomBytes(32).toString("hex");
    console.warn(
      "[tasteprobe] SESSION_SIGNING_SECRET not set; using an ephemeral random secret (mock development only). Sessions will not survive a restart.",
    );
  }
  return store[EPHEMERAL_KEY];
}

/** Reads the provider mode without validating the rest (used for error metadata). */
export function readProviderMode(env: EnvSource = process.env): ProviderMode {
  return env.QLOO_MODE === "live" ? "live" : "mock";
}

/**
 * Production always uses the shared Redis store and fails closed without it;
 * there is no silent fallback to process memory.
 */
function resolveSessionStore(e: z.infer<typeof EnvSchema>): AppConfig["sessionStore"] {
  const production = e.NODE_ENV === "production";
  if (production && e.SESSION_STORE === "memory") {
    throw new AppError("CONFIG_ERROR", 500, "The in-memory session store is not allowed in production");
  }
  const kind = production ? "redis" : (e.SESSION_STORE ?? "memory");
  if (kind === "memory") return { kind };
  const url = e.UPSTASH_REDIS_REST_URL;
  const token = e.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new AppError(
      "CONFIG_ERROR",
      500,
      "UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required for the Redis session store",
    );
  }
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    // reported below
  }
  if (protocol !== "https:") throw new AppError("CONFIG_ERROR", 500, "UPSTASH_REDIS_REST_URL must be an HTTPS URL");
  return { kind, url, token };
}

export function loadConfig(env: EnvSource = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    // Report variable names only, never values.
    const names = [...new Set(parsed.error.issues.map((i) => String(i.path[0])))].join(", ");
    throw new AppError("CONFIG_ERROR", 500, `Invalid environment configuration: ${names}`);
  }
  const e = parsed.data;

  let signingSecret = e.SESSION_SIGNING_SECRET;
  let secretIsEphemeral = false;
  if (!signingSecret) {
    if (e.QLOO_MODE === "mock" && e.NODE_ENV !== "production") {
      signingSecret = ephemeralDevSecret();
      secretIsEphemeral = true;
    } else {
      throw new AppError("CONFIG_ERROR", 500, "SESSION_SIGNING_SECRET is required");
    }
  }
  if (signingSecret.length < MIN_SECRET_LENGTH) {
    throw new AppError(
      "CONFIG_ERROR",
      500,
      `SESSION_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
    );
  }

  return {
    nodeEnv: e.NODE_ENV,
    mode: e.QLOO_MODE,
    sessionStore: resolveSessionStore(e),
    qloo: { apiKey: e.QLOO_API_KEY, baseUrl: e.QLOO_BASE_URL, timeoutMs: e.QLOO_TIMEOUT_MS },
    llm: {
      provider: e.LLM_PROVIDER,
      model: e.LLM_MODEL,
      apiKey: e.GOOGLE_API_KEY,
      temperature: e.LLM_TEMPERATURE,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    session: { signingSecret, ttlSeconds: e.SESSION_TTL_SECONDS, secretIsEphemeral },
    limits: {
      maxQuestions: e.MAX_QUESTIONS,
      maxQlooCallsPerSession: e.MAX_QLOO_CALLS_PER_SESSION,
      maxAgentToolCallsPerTurn: e.MAX_AGENT_TOOL_CALLS_PER_TURN,
      maxRecommendationCandidates: e.MAX_RECOMMENDATION_CANDIDATES,
      finalRecommendationCount: e.FINAL_RECOMMENDATION_COUNT,
    },
    features: {
      questionGenerationMode: e.QUESTION_GENERATION_MODE,
      adaptiveQuestioning: e.ENABLE_ADAPTIVE_QUESTIONING,
      earlyStopping: e.ENABLE_EARLY_STOPPING,
      qlooCache: e.ENABLE_QLOO_CACHE,
      cacheTtlSeconds: e.CACHE_TTL_SECONDS,
      evaluationLogging: e.ENABLE_EVALUATION_LOGGING,
      agentTracing: e.ENABLE_AGENT_TRACING,
    },
    sentryDsn: e.SENTRY_DSN,
  };
}
