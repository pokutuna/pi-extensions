import assert from "node:assert/strict";
import test from "node:test";

import { resolveConfig } from "../src/config.ts";

test("CLI config resolves env references without exposing literals in the config shape", () => {
  const providers = resolveConfig(
    {
      providers: {
        openai: {
          upstreamBaseUrl: "https://api.openai.com/v1",
          headers: {
            Authorization: { env: "OPENAI_API_KEY", prefix: "Bearer " },
          },
        },
      },
    },
    { OPENAI_API_KEY: "sentinel" },
  );
  assert.deepEqual(providers.openai?.headers, { Authorization: "Bearer sentinel" });
});

test("CLI config retains custom provider registration metadata", () => {
  const providers = resolveConfig(
    {
      providers: {
        "acme-ai": {
          upstreamBaseUrl: "https://llm.example.com/v1",
          headers: { Authorization: { env: "ACME_API_KEY", prefix: "Bearer " } },
          registration: {
            api: "openai-responses",
            models: [
              {
                id: "acme-chat",
                name: "Acme Chat",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
            ],
          },
        },
      },
    },
    { ACME_API_KEY: "sentinel" },
  );
  assert.deepEqual(providers["acme-ai"]?.registration, {
    api: "openai-responses",
    models: [
      {
        id: "acme-chat",
        name: "Acme Chat",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      },
    ],
  });
});

test("CLI config rejects missing references and literal headers", () => {
  assert.throws(
    () =>
      resolveConfig(
        {
          providers: {
            openai: {
              upstreamBaseUrl: "https://api.openai.com/v1",
              headers: { Authorization: { env: "OPENAI_API_KEY" } },
            },
          },
        },
        {},
      ),
    /missing environment variable OPENAI_API_KEY/,
  );
  assert.throws(
    () =>
      resolveConfig(
        {
          providers: {
            openai: {
              upstreamBaseUrl: "https://api.openai.com/v1",
              headers: { Authorization: "Bearer literal" },
            },
          },
        },
        {},
      ),
    /must be an object/,
  );
});
