import assert from "node:assert/strict";
import test from "node:test";

import { parseManifest } from "../src/manifest.ts";

const brokerUrl = "http://127.0.0.1:43127/";
const model = {
  id: "acme-chat",
  name: "Acme Chat",
  reasoning: false,
  input: ["text"],
  contextWindow: 128000,
  maxTokens: 16384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

test("manifest parser accepts override and custom routes", () => {
  const manifest = parseManifest(
    {
      version: 1,
      providers: [
        {
          mode: "override",
          provider: "openai",
          baseUrl: `${brokerUrl}providers/openai/v1`,
        },
        {
          mode: "custom",
          provider: "acme-ai",
          baseUrl: `${brokerUrl}providers/acme-ai/v1`,
          api: "openai-responses",
          models: [model],
        },
      ],
    },
    brokerUrl,
  );
  assert.equal(manifest.providers.length, 2);
});

test("manifest parser rejects external routes and unknown fields", () => {
  assert.throws(
    () =>
      parseManifest(
        {
          version: 1,
          providers: [
            {
              mode: "override",
              provider: "openai",
              baseUrl: "https://api.openai.com/v1",
            },
          ],
        },
        brokerUrl,
      ),
    /same origin|broker origin/,
  );
  assert.throws(
    () =>
      parseManifest(
        {
          version: 1,
          providers: [
            {
              mode: "override",
              provider: "openai",
              baseUrl: `${brokerUrl}providers/openai/v1`,
              token: "must-not-be-here",
            },
          ],
        },
        brokerUrl,
      ),
    /unknown field/,
  );
});
