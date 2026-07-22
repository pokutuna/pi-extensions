import assert from "node:assert/strict";
import { test } from "node:test";
import { authCacheKey } from "../src/client.ts";

test("authCacheKey: Vertex API keys are hashed and isolated", () => {
  const first = authCacheKey({
    backend: "vertex-ai",
    apiKey: "vertex-key-a",
  });
  const second = authCacheKey({
    backend: "vertex-ai",
    apiKey: "vertex-key-b",
  });

  assert.notEqual(first, second);
  assert.match(first, /^vertex-ai-api-key\0/);
  assert.ok(!first.includes("vertex-key-a"));
});

test("authCacheKey: ADC settings are isolated from Vertex API keys", () => {
  const adc = authCacheKey({
    backend: "vertex-ai",
    project: "project",
    location: "global",
  });
  const apiKey = authCacheKey({
    backend: "vertex-ai",
    apiKey: "vertex-key",
  });

  assert.notEqual(adc, apiKey);
});
