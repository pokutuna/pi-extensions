import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { BROKER_DUMMY_API_KEY } from "../src/contract.ts";
import { parseBrokerUrl } from "../src/broker-url.ts";
import { startModelBroker } from "../src/server.ts";

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  server.close();
  await once(server, "close");
}

test("Broker URL parser accepts loopback HTTP and rejects unsafe roots", () => {
  assert.equal(parseBrokerUrl("http://127.0.0.1:1234").toString(), "http://127.0.0.1:1234/");
  assert.equal(
    parseBrokerUrl("https://broker.example.test").toString(),
    "https://broker.example.test/",
  );
  assert.throws(() => parseBrokerUrl("http://broker.example.test:1234"), /loopback/);
  assert.throws(() => parseBrokerUrl("http://127.0.0.1:1234/v1"), /pathname/);
  assert.throws(() => parseBrokerUrl("http://user:pass@127.0.0.1:1234"), /userinfo/);
});

test("Broker exposes a non-secret manifest and injects configured headers", async () => {
  let upstreamRequest: IncomingMessage | undefined;
  let upstreamBody = "";
  const upstream = createServer((req, res) => {
    upstreamRequest = req;
    req.setEncoding("utf8");
    req.on("data", (chunk) => (upstreamBody += chunk));
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "x-upstream": "yes",
      });
      res.write("data: first\n\n");
      setTimeout(() => {
        res.end("data: second\n\n");
      }, 10);
    });
  });
  const upstreamUrl = await listen(upstream);
  const broker = await startModelBroker({
    listen: { host: "127.0.0.1", port: 0 },
    allowInsecureHttp: true,
    providers: {
      openai: {
        upstreamBaseUrl: `${upstreamUrl}/v1`,
        headers: { Authorization: "Bearer real-upstream-token" },
      },
    },
  });

  try {
    const manifestResponse = await fetch(`${broker.url}v1/providers`);
    assert.equal(manifestResponse.status, 200);
    const manifest = (await manifestResponse.json()) as {
      providers: Array<{ baseUrl: string }>;
    };
    assert.equal(manifest.providers[0]?.baseUrl, `${broker.url}providers/openai/v1`);

    const response = await fetch(`${broker.url}providers/openai/v1/responses?stream=true`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${BROKER_DUMMY_API_KEY}`,
        "x-api-key": "incoming-secret",
        "x-request-id": "request-1",
        "content-type": "application/json",
      },
      body: JSON.stringify({ hello: "world" }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-upstream"), "yes");
    assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
    assert.equal(upstreamRequest?.url, "/v1/responses?stream=true");
    assert.equal(upstreamRequest?.headers.authorization, "Bearer real-upstream-token");
    assert.equal(upstreamRequest?.headers["x-api-key"], undefined);
    assert.equal(upstreamRequest?.headers["x-request-id"], "request-1");
    assert.equal(upstreamBody, JSON.stringify({ hello: "world" }));
  } finally {
    await broker.close();
    await close(upstream);
  }
});

test("Broker does not follow upstream redirects", async () => {
  const upstream = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(302, { location: "https://example.invalid/escaped" });
    res.end();
  });
  const upstreamUrl = await listen(upstream);
  const broker = await startModelBroker({
    listen: { host: "127.0.0.1", port: 0 },
    allowInsecureHttp: true,
    providers: {
      openai: {
        upstreamBaseUrl: upstreamUrl,
        headers: { Authorization: "Bearer token" },
      },
    },
  });
  try {
    const response = await fetch(`${broker.url}providers/openai`, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), "https://example.invalid/escaped");
  } finally {
    await broker.close();
    await close(upstream);
  }
});
