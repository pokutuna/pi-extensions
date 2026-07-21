import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { BROKER_DUMMY_API_KEY } from "../src/contract.ts";
import providerRoutingExtension from "../src/extension.ts";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}/`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  server.close();
  await once(server, "close");
}

test("extension is a no-op when the Broker URL is not configured", async () => {
  const previous = process.env.PI_MODEL_BROKER_URL;
  delete process.env.PI_MODEL_BROKER_URL;
  const registrations: unknown[] = [];
  const pi = {
    registerProvider(_name: string, config: unknown) {
      registrations.push(config);
    },
  } as unknown as ExtensionAPI;
  try {
    await providerRoutingExtension(pi);
    assert.deepEqual(registrations, []);
  } finally {
    if (previous === undefined) delete process.env.PI_MODEL_BROKER_URL;
    else process.env.PI_MODEL_BROKER_URL = previous;
  }
});

test("extension registers override and custom routes with a dummy key", async () => {
  const server = createServer((_req, res) => {
    const body = JSON.stringify({
      version: 1,
      providers: [
        {
          mode: "override",
          provider: "openai",
          baseUrl: `${process.env.TEST_BROKER_URL}providers/openai/v1`,
        },
        {
          mode: "custom",
          provider: "acme-ai",
          baseUrl: `${process.env.TEST_BROKER_URL}providers/acme-ai/v1`,
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
      ],
    });
    res.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  });
  const brokerUrl = await listen(server);
  const previous = process.env.PI_MODEL_BROKER_URL;
  process.env.PI_MODEL_BROKER_URL = brokerUrl;
  process.env.TEST_BROKER_URL = brokerUrl;
  const registrations: Array<{ name: string; config: unknown }> = [];
  const pi = {
    registerProvider(name: string, config: unknown) {
      registrations.push({ name, config });
    },
  } as unknown as ExtensionAPI;
  try {
    await providerRoutingExtension(pi);
    assert.deepEqual(registrations, [
      {
        name: "openai",
        config: {
          baseUrl: `${brokerUrl}providers/openai/v1`,
          apiKey: BROKER_DUMMY_API_KEY,
        },
      },
      {
        name: "acme-ai",
        config: {
          baseUrl: `${brokerUrl}providers/acme-ai/v1`,
          apiKey: BROKER_DUMMY_API_KEY,
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
    ]);
  } finally {
    if (previous === undefined) delete process.env.PI_MODEL_BROKER_URL;
    else process.env.PI_MODEL_BROKER_URL = previous;
    delete process.env.TEST_BROKER_URL;
    await close(server);
  }
});

test("extension rejects an invalid manifest before registering anything", async () => {
  const server = createServer((_req, res) => {
    const body = JSON.stringify({
      version: 2,
      providers: [],
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(body);
  });
  const brokerUrl = await listen(server);
  const previous = process.env.PI_MODEL_BROKER_URL;
  process.env.PI_MODEL_BROKER_URL = brokerUrl;
  const registrations: unknown[] = [];
  const pi = {
    registerProvider(_name: string, config: unknown) {
      registrations.push(config);
    },
  } as unknown as ExtensionAPI;
  try {
    await assert.rejects(() => providerRoutingExtension(pi), /unsupported manifest version/);
    assert.deepEqual(registrations, []);
  } finally {
    if (previous === undefined) delete process.env.PI_MODEL_BROKER_URL;
    else process.env.PI_MODEL_BROKER_URL = previous;
    await close(server);
  }
});
