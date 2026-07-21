import { readFile } from "node:fs/promises";

import type { CustomProviderRegistration, ModelBrokerProviderConfig } from "./contract.ts";
import { parseCustomProviderRegistration } from "./manifest.ts";
import type { StartModelBrokerOptions } from "./server.ts";

interface ConfigHeaderReference {
  env: string;
  prefix?: string;
}

interface RawProvider {
  upstreamBaseUrl: string;
  headers: Record<string, ConfigHeaderReference>;
  registration?: CustomProviderRegistration;
}

interface RawConfig {
  providers: Record<string, RawProvider>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "")
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function assertKeys(value: Record<string, unknown>, keys: string[], label: string): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown field "${key}"`);
  }
}

function parseHeaderReference(value: unknown, label: string): ConfigHeaderReference {
  const entry = object(value, label);
  assertKeys(entry, ["env", "prefix"], label);
  const env = nonEmptyString(entry.env, `${label}.env`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(env))
    throw new Error(`${label}.env must be an environment variable name`);
  const prefix =
    entry.prefix === undefined ? undefined : nonEmptyString(entry.prefix, `${label}.prefix`);
  return { env, ...(prefix !== undefined ? { prefix } : {}) };
}

function parseRawConfig(value: unknown): RawConfig {
  const root = object(value, "config");
  assertKeys(root, ["providers"], "config");
  const providersObject = object(root.providers, "config.providers");
  const providers: Record<string, RawProvider> = {};
  for (const [provider, rawValue] of Object.entries(providersObject)) {
    const entry = object(rawValue, `config.providers.${provider}`);
    assertKeys(
      entry,
      ["upstreamBaseUrl", "headers", "registration"],
      `config.providers.${provider}`,
    );
    const headersObject = object(entry.headers, `config.providers.${provider}.headers`);
    const headers: Record<string, ConfigHeaderReference> = {};
    for (const [name, headerValue] of Object.entries(headersObject)) {
      headers[name] = parseHeaderReference(
        headerValue,
        `config.providers.${provider}.headers.${name}`,
      );
    }
    providers[provider] = {
      upstreamBaseUrl: nonEmptyString(
        entry.upstreamBaseUrl,
        `config.providers.${provider}.upstreamBaseUrl`,
      ),
      headers,
      ...(entry.registration !== undefined
        ? {
            registration: parseCustomProviderRegistration(
              entry.registration,
              `config.providers.${provider}.registration`,
            ),
          }
        : {}),
    };
  }
  return { providers };
}

export function resolveConfig(
  value: unknown,
  env: NodeJS.ProcessEnv,
): StartModelBrokerOptions["providers"] {
  const config = parseRawConfig(value);
  const providers: Record<string, ModelBrokerProviderConfig> = {};
  for (const [provider, entry] of Object.entries(config.providers)) {
    const headers: Record<string, string> = {};
    for (const [name, reference] of Object.entries(entry.headers)) {
      const value = env[reference.env];
      if (value === undefined || value === "") {
        throw new Error(
          `missing environment variable ${reference.env} for provider "${provider}" header "${name}"`,
        );
      }
      headers[name] = `${reference.prefix ?? ""}${value}`;
    }
    providers[provider] = {
      upstreamBaseUrl: entry.upstreamBaseUrl,
      headers,
      ...(entry.registration !== undefined ? { registration: entry.registration } : {}),
    };
  }
  return providers;
}

export async function loadConfigFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StartModelBrokerOptions["providers"]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`failed to read Broker config ${path}`, { cause: error });
  }
  return resolveConfig(parsed, env);
}
