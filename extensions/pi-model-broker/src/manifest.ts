import { assertManifestRouteUrl, assertProviderName, parseBrokerUrl } from "./broker-url.ts";
import {
  MANIFEST_VERSION,
  type CustomProviderRegistration,
  type CustomProviderRoute,
  type ModelCompat,
  type ModelCost,
  type ModelMetadata,
  type OverrideProviderRoute,
  type ProviderRoute,
  type ProvidersManifest,
  SUPPORTED_APIS,
  type SupportedApi,
} from "./contract.ts";

const MODEL_KEYS = new Set([
  "id",
  "name",
  "reasoning",
  "input",
  "cost",
  "contextWindow",
  "maxTokens",
  "api",
  "thinkingLevelMap",
  "compat",
]);

const COST_KEYS = new Set(["input", "output", "cacheRead", "cacheWrite"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const COMPAT_KEYS = new Set([
  "supportsStore",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "maxTokensField",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "thinkingFormat",
  "chatTemplateKwargs",
  "cacheControlFormat",
  "supportsEagerToolInputStreaming",
  "supportsLongCacheRetention",
  "sendSessionAffinityHeaders",
  "supportsCacheControlOnTools",
  "forceAdaptiveThinking",
  "allowEmptySignature",
]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
  return value;
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function noUnknownKeys(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field "${key}"`);
  }
}

function parseApi(value: unknown, label: string): SupportedApi {
  if (typeof value !== "string" || !(SUPPORTED_APIS as readonly string[]).includes(value)) {
    throw new Error(`${label} must be one of ${SUPPORTED_APIS.join(", ")}`);
  }
  return value as SupportedApi;
}

function parseCost(value: unknown, label: string): ModelCost {
  const object = record(value, label);
  noUnknownKeys(object, COST_KEYS, label);
  for (const key of COST_KEYS) {
    if (!(key in object)) throw new Error(`${label}.${key} is required`);
  }
  return {
    input: numberValue(object.input, `${label}.input`),
    output: numberValue(object.output, `${label}.output`),
    cacheRead: numberValue(object.cacheRead, `${label}.cacheRead`),
    cacheWrite: numberValue(object.cacheWrite, `${label}.cacheWrite`),
  };
}

function parseThinkingLevelMap(value: unknown, label: string): ModelMetadata["thinkingLevelMap"] {
  const object = record(value, label);
  const result: NonNullable<ModelMetadata["thinkingLevelMap"]> = {};
  for (const [key, entry] of Object.entries(object)) {
    if (!THINKING_LEVELS.has(key)) {
      throw new Error(`${label} has unknown thinking level "${key}"`);
    }
    if (entry !== null && typeof entry !== "string") {
      throw new Error(`${label}.${key} must be string or null`);
    }
    result[key as keyof typeof result] = entry;
  }
  return result;
}

function isJsonValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}

function parseCompat(value: unknown, label: string): ModelCompat {
  const object = record(value, label);
  noUnknownKeys(object, COMPAT_KEYS, label);
  if (object.maxTokensField !== undefined) {
    if (
      object.maxTokensField !== "max_completion_tokens" &&
      object.maxTokensField !== "max_tokens"
    ) {
      throw new Error(`${label}.maxTokensField is invalid`);
    }
  }
  if (object.thinkingFormat !== undefined && typeof object.thinkingFormat !== "string") {
    throw new Error(`${label}.thinkingFormat must be a string`);
  }
  if (object.cacheControlFormat !== undefined && object.cacheControlFormat !== "anthropic") {
    throw new Error(`${label}.cacheControlFormat is invalid`);
  }
  if (object.chatTemplateKwargs !== undefined) {
    const kwargs = record(object.chatTemplateKwargs, `${label}.chatTemplateKwargs`);
    if (!Object.values(kwargs).every(isJsonValue)) {
      throw new Error(`${label}.chatTemplateKwargs must contain JSON values`);
    }
  }
  for (const [key, entry] of Object.entries(object)) {
    if (
      key !== "maxTokensField" &&
      key !== "thinkingFormat" &&
      key !== "cacheControlFormat" &&
      key !== "chatTemplateKwargs" &&
      typeof entry !== "boolean"
    ) {
      throw new Error(`${label}.${key} must be boolean`);
    }
  }
  return object;
}

function parseModel(value: unknown, label: string): ModelMetadata {
  const object = record(value, label);
  noUnknownKeys(object, MODEL_KEYS, label);
  for (const key of ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens"]) {
    if (!(key in object)) throw new Error(`${label}.${key} is required`);
  }
  if (
    typeof object.input !== "object" ||
    !Array.isArray(object.input) ||
    object.input.length === 0
  ) {
    throw new Error(`${label}.input must be a non-empty array`);
  }
  const input = object.input.map((entry, index) => {
    if (entry !== "text" && entry !== "image") {
      throw new Error(`${label}.input[${index}] must be text or image`);
    }
    return entry;
  });
  if (new Set(input).size !== input.length) {
    throw new Error(`${label}.input must not contain duplicates`);
  }
  return {
    id: stringValue(object.id, `${label}.id`),
    name: stringValue(object.name, `${label}.name`),
    reasoning: booleanValue(object.reasoning, `${label}.reasoning`),
    input,
    cost: parseCost(object.cost, `${label}.cost`),
    contextWindow: numberValue(object.contextWindow, `${label}.contextWindow`),
    maxTokens: numberValue(object.maxTokens, `${label}.maxTokens`),
    ...(object.api !== undefined ? { api: parseApi(object.api, `${label}.api`) } : {}),
    ...(object.thinkingLevelMap !== undefined
      ? {
          thinkingLevelMap: parseThinkingLevelMap(
            object.thinkingLevelMap,
            `${label}.thinkingLevelMap`,
          ),
        }
      : {}),
    ...(object.compat !== undefined
      ? { compat: parseCompat(object.compat, `${label}.compat`) }
      : {}),
  };
}

export function parseCustomProviderRegistration(
  value: unknown,
  label: string,
): CustomProviderRegistration {
  const object = record(value, label);
  noUnknownKeys(object, new Set(["api", "models"]), label);
  if (!Array.isArray(object.models) || object.models.length === 0) {
    throw new Error(`${label}.models must be a non-empty array`);
  }
  const models = object.models.map((model, modelIndex) =>
    parseModel(model, `${label}.models[${modelIndex}]`),
  );
  const ids = new Set<string>();
  for (const model of models) {
    if (ids.has(model.id)) throw new Error(`${label}.models has duplicate id "${model.id}"`);
    ids.add(model.id);
  }
  return {
    api: parseApi(object.api, `${label}.api`),
    models,
  };
}

function parseRoute(value: unknown, index: number, brokerUrl: URL): ProviderRoute {
  const label = `providers[${index}]`;
  const object = record(value, label);
  const mode = object.mode;
  const provider = stringValue(object.provider, `${label}.provider`);
  assertProviderName(provider);
  const baseUrl = stringValue(object.baseUrl, `${label}.baseUrl`);
  assertManifestRouteUrl(baseUrl, brokerUrl, provider);

  if (mode === "override") {
    noUnknownKeys(object, new Set(["mode", "provider", "baseUrl"]), label);
    return { mode, provider, baseUrl } satisfies OverrideProviderRoute;
  }
  if (mode === "custom") {
    noUnknownKeys(object, new Set(["mode", "provider", "baseUrl", "api", "models"]), label);
    const registration = parseCustomProviderRegistration(
      { api: object.api, models: object.models },
      label,
    );
    return {
      mode,
      provider,
      baseUrl,
      ...registration,
    } satisfies CustomProviderRoute;
  }
  throw new Error(`${label}.mode must be override or custom`);
}

export function parseManifest(value: unknown, brokerUrlValue: string | URL): ProvidersManifest {
  const brokerUrl =
    typeof brokerUrlValue === "string" ? parseBrokerUrl(brokerUrlValue) : brokerUrlValue;
  const object = record(value, "manifest");
  noUnknownKeys(object, new Set(["version", "providers"]), "manifest");
  if (object.version !== MANIFEST_VERSION) {
    throw new Error(`unsupported manifest version ${String(object.version)}`);
  }
  if (!Array.isArray(object.providers) || object.providers.length === 0) {
    throw new Error("manifest.providers must be a non-empty array");
  }
  const providers = object.providers.map((entry, index) => parseRoute(entry, index, brokerUrl));
  const names = new Set<string>();
  for (const provider of providers) {
    if (names.has(provider.provider)) {
      throw new Error(`manifest.providers has duplicate provider "${provider.provider}"`);
    }
    names.add(provider.provider);
  }
  return { version: MANIFEST_VERSION, providers };
}

export function createManifest(brokerUrlValue: string, routes: ProviderRoute[]): ProvidersManifest {
  const brokerUrl = parseBrokerUrl(brokerUrlValue);
  return parseManifest({ version: MANIFEST_VERSION, providers: routes }, brokerUrl);
}
