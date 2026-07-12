import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_LOCATION,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  describeAuth,
  normalizeConfig,
  resolveAuth,
  type ApiKeyRegistry,
} from "../src/config.ts";

const emptyEnv = {};

function registryWith(key: string | undefined): ApiKeyRegistry {
  return { getApiKeyForProvider: async () => key };
}

test("normalizeConfig: defaults for empty input", () => {
  const { config, warnings } = normalizeConfig(undefined);
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(config.auth, undefined);
  assert.equal(config.apiKey, undefined);
  assert.deepEqual(warnings, []);
});

test("normalizeConfig: accepts valid fields", () => {
  const { config, warnings } = normalizeConfig({
    auth: "vertex-ai",
    project: "my-project",
    location: "us-central1",
    model: "gemini-x",
    timeoutMs: 1234,
  });
  assert.equal(config.auth, "vertex-ai");
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
    model: 42,
    timeoutMs: -1,
  });
  assert.equal(config.auth, undefined);
  assert.equal(config.model, DEFAULT_MODEL);
  assert.equal(config.timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(warnings.length, 3);
});

test("normalizeConfig: non-object input yields defaults", () => {
  const { config } = normalizeConfig("nope");
  assert.equal(config.model, DEFAULT_MODEL);
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
  const { config } = normalizeConfig({});
  const auth = await resolveAuth(config, emptyEnv, registryWith("registry-key"));
  assert.equal(auth.backend === "api-key" && auth.apiKey, "registry-key");
  assert.equal(auth.backend === "api-key" && auth.source, "pi auth (/login google)");
});

test("resolveAuth: rejects interpolation-style config apiKey", async () => {
  const { config } = normalizeConfig({ apiKey: "$GEMINI_API_KEY" });
  await assert.rejects(() => resolveAuth(config, emptyEnv), /interpolation is not supported/i);
});

test("resolveAuth: rejects command-style config apiKey", async () => {
  const { config } = normalizeConfig({ apiKey: "!get-key" });
  await assert.rejects(() => resolveAuth(config, emptyEnv), /interpolation is not supported/i);
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

test("resolveAuth: auto-detects vertex when only a project is resolvable", async () => {
  const { config } = normalizeConfig({});
  const auth = await resolveAuth(config, { GOOGLE_CLOUD_PROJECT: "proj" });
  assert.equal(auth.backend, "vertex-ai");
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
  await assert.rejects(() => resolveAuth(config, emptyEnv), /no API key was found/);
});

test("resolveAuth: vertex backend without project fails with guidance", async () => {
  const { config } = normalizeConfig({ auth: "vertex-ai" });
  await assert.rejects(() => resolveAuth(config, emptyEnv), /no project was found/);
});

test("describeAuth: never contains the API key", async () => {
  const { config } = normalizeConfig({ apiKey: "super-secret-key" });
  const auth = await resolveAuth(config, emptyEnv);
  const described = describeAuth(auth);
  assert.ok(!described.includes("super-secret-key"));
  assert.match(described, /api-key/);
});
