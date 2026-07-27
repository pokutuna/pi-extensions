import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LOCATION,
  DEFAULT_LOOKUP_PI_CONFIG,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  describeAuth,
  normalizeConfig,
  resolveAuth,
  type ApiKeyRegistry,
} from "../src/config.ts";

const emptyEnv = {};

function registryWith(key: string | undefined): ApiKeyRegistry {
  return registryWithProviders({ google: key });
}

function registryWithProviders(
  keys: Record<string, string | undefined>,
): ApiKeyRegistry {
  return {
    getApiKeyForProvider: async (provider) => keys[provider],
  };
}

test("normalizeConfig: defaults for empty input", () => {
  const { config, warnings } = normalizeConfig(undefined);
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(config.auth, undefined);
  assert.equal(config.lookupPiConfig, DEFAULT_LOOKUP_PI_CONFIG);
  assert.equal(config.apiKey, undefined);
  assert.deepEqual(warnings, []);
});

test("normalizeConfig: accepts valid fields", () => {
  const { config, warnings } = normalizeConfig({
    auth: "vertex-ai",
    lookupPiConfig: true,
    project: "my-project",
    location: "us-central1",
    model: "gemini-x",
    timeoutMs: 1234,
  });
  assert.equal(config.auth, "vertex-ai");
  assert.equal(config.lookupPiConfig, true);
  assert.equal(config.project, "my-project");
  assert.equal(config.location, "us-central1");
  assert.equal(config.model, "gemini-x");
  assert.equal(config.timeoutMs, 1234);
  assert.deepEqual(warnings, []);
});

test("normalizeConfig: warns on unknown fields", () => {
  const { warnings } = normalizeConfig({ nope: 1 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown field "nope"/);
});

test("normalizeConfig: warns and falls back on invalid values", () => {
  const { config, warnings } = normalizeConfig({
    auth: "bogus",
    lookupPiConfig: "yes",
    model: 42,
    timeoutMs: -1,
  });
  assert.equal(config.auth, undefined);
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(warnings.length, 4);
});

test("normalizeConfig: non-object input yields defaults", () => {
  const { config, warnings } = normalizeConfig("nope");
  assert.equal(config.model, DEFAULT_MODEL);
  // A string must not be walked as if it were a config object, which would
  // turn each character index into an "unknown field" warning.
  assert.deepEqual(warnings, []);
});

test("resolveAuth: config apiKey wins over env", async () => {
  const { config } = normalizeConfig({ apiKey: "config-key" });
  const auth = await resolveAuth(config, { GEMINI_API_KEY: "env-key" });
  assert.deepEqual(auth, {
    backend: "api-key",
    apiKey: "config-key",
    source: "config apiKey",
  });
});

test("resolveAuth: GEMINI_API_KEY wins over GOOGLE_API_KEY", async () => {
  const { config } = normalizeConfig({});
  const auth = await resolveAuth(config, {
    GEMINI_API_KEY: "gemini-key",
    GOOGLE_API_KEY: "google-key",
  });
  assert.equal(auth.backend, "api-key");
  assert.equal(auth.backend === "api-key" && auth.apiKey, "gemini-key");
});

test("resolveAuth: GOOGLE_API_KEY used when GEMINI_API_KEY absent", async () => {
  const { config } = normalizeConfig({});
  const auth = await resolveAuth(config, { GOOGLE_API_KEY: "google-key" });
  assert.equal(auth.backend === "api-key" && auth.apiKey, "google-key");
});

test("resolveAuth: falls back to pi auth registry", async () => {
  const { config } = normalizeConfig({ lookupPiConfig: true });
  const auth = await resolveAuth(
    config,
    emptyEnv,
    registryWith("registry-key"),
  );
  assert.equal(auth.backend === "api-key" && auth.apiKey, "registry-key");
  assert.equal(auth.backend === "api-key" && auth.source, "pi provider google");
});

test("resolveAuth: current google provider uses pi google auth", async () => {
  const { config } = normalizeConfig({ lookupPiConfig: true });
  const auth = await resolveAuth(
    config,
    { GEMINI_API_KEY: "env-key" },
    registryWithProviders({ google: "pi-key" }),
    { currentProvider: "google" },
  );
  assert.deepEqual(auth, {
    backend: "api-key",
    apiKey: "pi-key",
    source: "pi provider google",
  });
});

test("resolveAuth: does not inspect pi providers by default", async () => {
  const { config } = normalizeConfig({});
  await assert.rejects(
    () =>
      resolveAuth(
        config,
        emptyEnv,
        registryWithProviders({ google: "pi-key" }),
        { currentProvider: "google" },
      ),
    /No Google GenAI authentication configured/,
  );
});

test("resolveAuth: current google-vertex provider uses pi Vertex API key", async () => {
  const { config } = normalizeConfig({ lookupPiConfig: true });
  const auth = await resolveAuth(
    config,
    { GEMINI_API_KEY: "unused", GOOGLE_CLOUD_PROJECT: "project" },
    registryWithProviders({ "google-vertex": "vertex-key" }),
    { currentProvider: "google-vertex" },
  );
  assert.deepEqual(auth, {
    backend: "vertex-ai",
    apiKey: "vertex-key",
    apiKeySource: "pi provider google-vertex",
  });
});

test("resolveAuth: current google-vertex provider uses pi Vertex ADC", async () => {
  const { config } = normalizeConfig({ lookupPiConfig: true });
  const auth = await resolveAuth(
    config,
    {
      GOOGLE_CLOUD_PROJECT: "project",
      GOOGLE_CLOUD_LOCATION: "asia-northeast1",
    },
    registryWithProviders({ "google-vertex": "<authenticated>" }),
    { currentProvider: "google-vertex" },
  );
  assert.deepEqual(auth, {
    backend: "vertex-ai",
    project: "project",
    location: "asia-northeast1",
    projectSource: "GOOGLE_CLOUD_PROJECT",
    locationSource: "GOOGLE_CLOUD_LOCATION",
  });
});

test("resolveAuth: gcp-vertex-credentials marker falls back to ADC", async () => {
  const { config } = normalizeConfig({ lookupPiConfig: true });
  const auth = await resolveAuth(
    config,
    { GOOGLE_CLOUD_PROJECT: "project" },
    registryWithProviders({ "google-vertex": "gcp-vertex-credentials" }),
    { currentProvider: "google-vertex" },
  );
  assert.deepEqual(auth, {
    backend: "vertex-ai",
    project: "project",
    location: DEFAULT_LOCATION,
    projectSource: "GOOGLE_CLOUD_PROJECT",
    locationSource: "default",
  });
});

test("resolveAuth: extension apiKey wins over current Vertex provider", async () => {
  const { config } = normalizeConfig({
    apiKey: "extension-key",
    lookupPiConfig: true,
  });
  const auth = await resolveAuth(
    config,
    { GOOGLE_CLOUD_PROJECT: "project" },
    registryWithProviders({ "google-vertex": "vertex-key" }),
    { currentProvider: "google-vertex" },
  );
  assert.deepEqual(auth, {
    backend: "api-key",
    apiKey: "extension-key",
    source: "config apiKey",
  });
});

test("resolveAuth: rejects interpolation-style config apiKey", async () => {
  const { config } = normalizeConfig({ apiKey: "$GEMINI_API_KEY" });
  await assert.rejects(
    () => resolveAuth(config, emptyEnv),
    /interpolation is not supported/i,
  );
});

test("resolveAuth: rejects command-style config apiKey", async () => {
  const { config } = normalizeConfig({ apiKey: "!get-key" });
  await assert.rejects(
    () => resolveAuth(config, emptyEnv),
    /interpolation is not supported/i,
  );
});

test("resolveAuth: config auth=vertex-ai selects vertex backend", async () => {
  const { config } = normalizeConfig({ auth: "vertex-ai", project: "proj" });
  const auth = await resolveAuth(config, { GEMINI_API_KEY: "unused" });
  assert.equal(auth.backend, "vertex-ai");
  assert.equal(auth.backend === "vertex-ai" && auth.project, "proj");
  assert.equal(auth.backend === "vertex-ai" && auth.location, DEFAULT_LOCATION);
});

test("resolveAuth: GOOGLE_GENAI_USE_VERTEXAI selects vertex backend", async () => {
  const { config } = normalizeConfig({});
  const auth = await resolveAuth(config, {
    GOOGLE_GENAI_USE_VERTEXAI: "true",
    GEMINI_API_KEY: "unused",
    GOOGLE_CLOUD_PROJECT: "env-proj",
    GOOGLE_CLOUD_LOCATION: "asia-northeast1",
  });
  assert.deepEqual(auth, {
    backend: "vertex-ai",
    project: "env-proj",
    location: "asia-northeast1",
    projectSource: "GOOGLE_CLOUD_PROJECT",
    locationSource: "GOOGLE_CLOUD_LOCATION",
  });
});

test("resolveAuth: falsy GOOGLE_GENAI_USE_VERTEXAI does not select vertex", async () => {
  const { config } = normalizeConfig({});
  const auth = await resolveAuth(config, {
    GOOGLE_GENAI_USE_VERTEXAI: "0",
    GEMINI_API_KEY: "key",
  });
  assert.equal(auth.backend, "api-key");
});

test("resolveAuth: config project wins over env project", async () => {
  const { config } = normalizeConfig({
    auth: "vertex-ai",
    project: "config-proj",
  });
  const auth = await resolveAuth(config, { GOOGLE_CLOUD_PROJECT: "env-proj" });
  assert.equal(auth.backend === "vertex-ai" && auth.project, "config-proj");
});

test("resolveAuth: auto-detects Vertex API key from pi provider", async () => {
  const { config } = normalizeConfig({ lookupPiConfig: true });
  const auth = await resolveAuth(
    config,
    emptyEnv,
    registryWithProviders({ "google-vertex": "vertex-key" }),
  );
  assert.deepEqual(auth, {
    backend: "vertex-ai",
    apiKey: "vertex-key",
    apiKeySource: "pi provider google-vertex",
  });
});

test("resolveAuth: uses GOOGLE_CLOUD_API_KEY for Vertex", async () => {
  const { config } = normalizeConfig({ lookupPiConfig: true });
  const auth = await resolveAuth(config, {
    GOOGLE_CLOUD_API_KEY: "cloud-key",
  });
  assert.deepEqual(auth, {
    backend: "vertex-ai",
    apiKey: "cloud-key",
    apiKeySource: "GOOGLE_CLOUD_API_KEY",
  });
});

test("resolveAuth: ignores GOOGLE_CLOUD_API_KEY without lookupPiConfig", async () => {
  const { config } = normalizeConfig({});
  await assert.rejects(
    () => resolveAuth(config, { GOOGLE_CLOUD_API_KEY: "cloud-key" }),
    /No Google GenAI authentication configured/,
  );
});

test("resolveAuth: falls back to GCLOUD_PROJECT for the Vertex project", async () => {
  const { config } = normalizeConfig({});
  const auth = await resolveAuth(config, { GCLOUD_PROJECT: "legacy-proj" });
  assert.deepEqual(auth, {
    backend: "vertex-ai",
    project: "legacy-proj",
    location: DEFAULT_LOCATION,
    projectSource: "GCLOUD_PROJECT",
    locationSource: "default",
  });
});

test("resolveAuth: api-key wins auto-detection over project", async () => {
  const { config } = normalizeConfig({});
  const auth = await resolveAuth(config, {
    GEMINI_API_KEY: "key",
    GOOGLE_CLOUD_PROJECT: "proj",
  });
  assert.equal(auth.backend, "api-key");
});

test("resolveAuth: fails with guidance when nothing is configured", async () => {
  const { config } = normalizeConfig({});
  await assert.rejects(
    () => resolveAuth(config, emptyEnv, registryWith(undefined)),
    /GEMINI_API_KEY[\s\S]*\/login google[\s\S]*gcloud auth application-default login/,
  );
});

test("resolveAuth: api-key backend without key fails with guidance", async () => {
  const { config } = normalizeConfig({ auth: "api-key" });
  await assert.rejects(
    () => resolveAuth(config, emptyEnv),
    /no API key was found/,
  );
});

test("resolveAuth: vertex backend without project fails with guidance", async () => {
  const { config } = normalizeConfig({ auth: "vertex-ai" });
  await assert.rejects(
    () => resolveAuth(config, emptyEnv),
    /no project was found/,
  );
});

test("describeAuth: never contains the API key", async () => {
  const { config } = normalizeConfig({ apiKey: "super-secret-key" });
  const auth = await resolveAuth(config, emptyEnv);
  const described = describeAuth(auth);
  assert.ok(!described.includes("super-secret-key"));
  assert.match(described, /api-key/);
});
