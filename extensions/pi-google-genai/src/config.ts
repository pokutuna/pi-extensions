import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_MODEL = "gemini-3.5-flash";
export const DEFAULT_LOCATION = "global";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_TIMEOUT_MS = 600_000;

const CONFIG_FILE_NAME = "google-genai.json";
const AUTH_MODES = ["api-key", "vertex-ai"] as const;
const KNOWN_KEYS = [
  "auth",
  "apiKey",
  "project",
  "location",
  "model",
  "timeoutMs",
];

export type AuthMode = (typeof AUTH_MODES)[number];

/** Normalized contents of google-genai.json. All fields are optional in the file. */
export interface GoogleGenaiConfig {
  auth?: AuthMode;
  apiKey?: string;
  project?: string;
  location?: string;
  model: string;
  timeoutMs: number;
}

export interface LoadedConfig {
  config: GoogleGenaiConfig;
  path: string;
  warnings: string[];
  configLoaded: boolean;
}

/** Minimal surface of pi's model registry used for API key fallback. */
export interface ApiKeyRegistry {
  getApiKeyForProvider(provider: string): Promise<string | undefined>;
}

export type ResolvedAuth =
  | { backend: "api-key"; apiKey: string; source: string }
  | {
      backend: "vertex-ai";
      project: string;
      location: string;
      projectSource: string;
      locationSource: string;
    };

type Env = Record<string, string | undefined>;

export function configPath(env: Env = process.env): string {
  return join(
    env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
    CONFIG_FILE_NAME,
  );
}

export async function loadConfig(
  env: Env = process.env,
): Promise<LoadedConfig> {
  const path = configPath(env);
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      warnings.push(
        `Failed to read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    raw = undefined;
  }
  const configLoaded = isObject(raw);
  if (raw !== undefined && !configLoaded) {
    warnings.push(
      `${CONFIG_FILE_NAME} must contain a JSON object; ignoring config.`,
    );
  }
  const normalized = normalizeConfig(configLoaded ? raw : undefined);
  return {
    config: normalized.config,
    path,
    warnings: [...warnings, ...normalized.warnings],
    configLoaded,
  };
}

/** Normalize a raw config value. Invalid or unknown fields warn and fall back to defaults. */
export function normalizeConfig(value: unknown): {
  config: GoogleGenaiConfig;
  warnings: string[];
} {
  const raw: Record<string, unknown> = isObject(value) ? value : {};
  const warnings: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.includes(key)) {
      warnings.push(`${CONFIG_FILE_NAME}: ignoring unknown field "${key}".`);
    }
  }

  let auth: AuthMode | undefined;
  if (raw.auth !== undefined) {
    if (
      typeof raw.auth === "string" &&
      (AUTH_MODES as readonly string[]).includes(raw.auth)
    ) {
      auth = raw.auth as AuthMode;
    } else {
      warnings.push(
        `${CONFIG_FILE_NAME}: auth must be one of ${AUTH_MODES.map((mode) => `"${mode}"`).join(", ")}; ignoring value.`,
      );
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (raw.timeoutMs !== undefined) {
    if (isValidTimeoutMs(raw.timeoutMs)) {
      timeoutMs = raw.timeoutMs;
    } else {
      warnings.push(
        `${CONFIG_FILE_NAME}: timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS}; ignoring value.`,
      );
    }
  }

  const config: GoogleGenaiConfig = {
    model: normalizeString(raw.model, "model", warnings) ?? DEFAULT_MODEL,
    timeoutMs,
  };
  if (auth) config.auth = auth;
  const apiKey = normalizeString(raw.apiKey, "apiKey", warnings);
  if (apiKey) config.apiKey = apiKey;
  const project = normalizeString(raw.project, "project", warnings);
  if (project) config.project = project;
  const location = normalizeString(raw.location, "location", warnings);
  if (location) config.location = location;
  return { config, warnings };
}

export function isValidTimeoutMs(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TIMEOUT_MS
  );
}

export function isUnsupportedConfigApiKey(apiKey: string): boolean {
  return apiKey.startsWith("$") || apiKey.startsWith("!");
}

/**
 * Resolve the auth backend and its credentials/settings.
 *
 * Precedence for every setting: config file > environment variables >
 * pi auth registry > default. Backend selection: config.auth >
 * GOOGLE_GENAI_USE_VERTEXAI > auto-detect (API key wins over project).
 */
export async function resolveAuth(
  config: GoogleGenaiConfig,
  env: Env = process.env,
  registry?: ApiKeyRegistry,
): Promise<ResolvedAuth> {
  const backend =
    config.auth ??
    (isTruthyEnv(env.GOOGLE_GENAI_USE_VERTEXAI) ? "vertex-ai" : undefined);

  if (backend === "api-key") {
    return resolveApiKeyAuth(config, env, registry, true);
  }
  if (backend === "vertex-ai") {
    return resolveVertexAuth(config, env, true);
  }

  // Auto-detect: prefer an API key when one is resolvable, else Vertex AI.
  const apiKeyAuth = await resolveApiKeyAuth(config, env, registry, false);
  if (apiKeyAuth) return apiKeyAuth;
  const vertexAuth = resolveVertexAuth(config, env, false);
  if (vertexAuth) return vertexAuth;

  throw new Error(
    [
      "No Google GenAI authentication configured. Use one of:",
      "- set the GEMINI_API_KEY (or GOOGLE_API_KEY) environment variable",
      "- run /login google in pi",
      `- set "apiKey" in ${configPath(env)}`,
      "- for Vertex AI: run `gcloud auth application-default login` and set",
      `  GOOGLE_CLOUD_PROJECT (or "project" in ${configPath(env)})`,
    ].join("\n"),
  );
}

async function resolveApiKeyAuth(
  config: GoogleGenaiConfig,
  env: Env,
  registry: ApiKeyRegistry | undefined,
  required: true,
): Promise<ResolvedAuth>;
async function resolveApiKeyAuth(
  config: GoogleGenaiConfig,
  env: Env,
  registry: ApiKeyRegistry | undefined,
  required: false,
): Promise<ResolvedAuth | undefined>;
async function resolveApiKeyAuth(
  config: GoogleGenaiConfig,
  env: Env,
  registry: ApiKeyRegistry | undefined,
  required: boolean,
): Promise<ResolvedAuth | undefined> {
  if (config.apiKey) {
    if (isUnsupportedConfigApiKey(config.apiKey)) {
      throw new Error(
        `Environment variable / command interpolation is not supported for "apiKey" in ${CONFIG_FILE_NAME}. ` +
          "Use a literal key, or leave it unset and set GEMINI_API_KEY / run /login google.",
      );
    }
    return {
      backend: "api-key",
      apiKey: config.apiKey,
      source: "config apiKey",
    };
  }
  if (env.GEMINI_API_KEY) {
    return {
      backend: "api-key",
      apiKey: env.GEMINI_API_KEY,
      source: "GEMINI_API_KEY",
    };
  }
  if (env.GOOGLE_API_KEY) {
    return {
      backend: "api-key",
      apiKey: env.GOOGLE_API_KEY,
      source: "GOOGLE_API_KEY",
    };
  }
  const registryKey = await registry?.getApiKeyForProvider("google");
  if (registryKey) {
    return {
      backend: "api-key",
      apiKey: registryKey,
      source: "pi auth (/login google)",
    };
  }
  if (!required) return undefined;
  throw new Error(
    "Google GenAI is set to the api-key backend but no API key was found. " +
      `Set GEMINI_API_KEY, run /login google, or set "apiKey" in ${configPath(env)}.`,
  );
}

function resolveVertexAuth(
  config: GoogleGenaiConfig,
  env: Env,
  required: true,
): ResolvedAuth;
function resolveVertexAuth(
  config: GoogleGenaiConfig,
  env: Env,
  required: false,
): ResolvedAuth | undefined;
function resolveVertexAuth(
  config: GoogleGenaiConfig,
  env: Env,
  required: boolean,
): ResolvedAuth | undefined {
  const project = config.project ?? env.GOOGLE_CLOUD_PROJECT;
  if (!project) {
    if (!required) return undefined;
    throw new Error(
      "Google GenAI is set to the vertex-ai backend but no project was found. " +
        `Set GOOGLE_CLOUD_PROJECT or "project" in ${configPath(env)}, and make sure ` +
        "Application Default Credentials are available (`gcloud auth application-default login`).",
    );
  }
  const projectSource = config.project
    ? "config project"
    : "GOOGLE_CLOUD_PROJECT";
  const location =
    config.location ?? env.GOOGLE_CLOUD_LOCATION ?? DEFAULT_LOCATION;
  const locationSource = config.location
    ? "config location"
    : env.GOOGLE_CLOUD_LOCATION
      ? "GOOGLE_CLOUD_LOCATION"
      : "default";
  return {
    backend: "vertex-ai",
    project,
    location,
    projectSource,
    locationSource,
  };
}

export function describeAuth(auth: ResolvedAuth): string {
  if (auth.backend === "api-key") {
    return `api-key (key from ${auth.source})`;
  }
  return `vertex-ai (project: ${auth.project} from ${auth.projectSource}, location: ${auth.location} from ${auth.locationSource}, credentials: ADC)`;
}

function isTruthyEnv(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && !["0", "false", "no", "off"].includes(normalized);
}

function normalizeString(
  value: unknown,
  field: string,
  warnings: string[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim()) return value.trim();
  warnings.push(
    `${CONFIG_FILE_NAME}: ${field} must be a non-empty string; ignoring value.`,
  );
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
