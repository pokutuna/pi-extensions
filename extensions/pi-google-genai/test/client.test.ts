import assert from "node:assert/strict";
import { test } from "node:test";
import { authCacheKey, toApiError } from "../src/client.ts";

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
  assert.ok(first.startsWith("vertex-ai-api-key\u0000"));
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

test("toApiError: an SDK error with a status becomes one message shape", () => {
  const error = Object.assign(new Error("Permission denied."), { status: 403 });

  const normalized = toApiError(error);

  assert.ok(normalized instanceof Error);
  assert.equal(
    normalized.message,
    "Google GenAI request failed (HTTP 403): Permission denied.",
  );
});

test("toApiError: a status the SDK already prefixed is not repeated", () => {
  const error = Object.assign(
    new Error("400 Resource setup has just started."),
    {
      status: 400,
    },
  );

  const normalized = toApiError(error);

  assert.ok(normalized instanceof Error);
  assert.equal(
    normalized.message,
    "Google GenAI request failed (HTTP 400): Resource setup has just started.",
  );
});

test("toApiError: anything without a numeric status passes through untouched", () => {
  const plain = new Error("socket hang up");
  assert.equal(toApiError(plain), plain);

  const stringStatus = Object.assign(new Error("nope"), { status: "403" });
  assert.equal(toApiError(stringStatus), stringStatus);

  assert.equal(toApiError("not an error"), "not an error");
});
