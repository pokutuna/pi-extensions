# @pokutuna/pi-model-broker

A loopback Model Broker and provider-routing extension for connecting `pi` to provider APIs
without passing long-lived API keys to the `pi` process.

```text
pi -> http://127.0.0.1:<port>/providers/openai/v1/responses
   -> https://api.openai.com/v1/responses
      + server-side Authorization header
```

The Broker is a reverse proxy to fixed upstreams. It does not implement provider protocols;
it reuses `pi`'s existing adapters.

## Quick start

Broker configuration uses environment variable references instead of secret literals.

```json
{
  "providers": {
    "openai": {
      "upstreamBaseUrl": "https://api.openai.com/v1",
      "headers": {
        "Authorization": { "env": "OPENAI_API_KEY", "prefix": "Bearer " }
      }
    }
  }
}
```

```sh
OPENAI_API_KEY="$OPENAI_API_KEY" \
  npx @pokutuna/pi-model-broker@0.1.0 serve \
  --config ./model-broker.json \
  --listen 127.0.0.1:43127
```

Run `pi` in a separate process and point the extension at the Broker.

```sh
PI_MODEL_BROKER_URL=http://127.0.0.1:43127/ \
  pi -e npm:@pokutuna/pi-model-broker@0.1.0 \
  --model openai/gpt-4
```

For a local package, replace the `-e` argument with `./extensions/pi-model-broker`.

## Extension behavior

When `PI_MODEL_BROKER_URL` is set, the extension fetches `/v1/providers` and registers only the
providers listed in the manifest through `pi.registerProvider()`.

- It exits without doing anything when the variable is unset.
- Providers not listed in the manifest are left unchanged.
- `override` uses `pi`'s existing model catalog.
- `custom` registers the models listed in the manifest.
- An invalid or unreachable configured Broker fails startup.

This allows `openai` to use the Broker while another built-in or custom provider continues to be
used by the same `pi` process.

## Custom providers

Set `registration` to add a provider without relying on a built-in provider name. This package does
not implement protocols, so `api` must refer to an adapter already supported by `pi`.

```json
{
  "providers": {
    "acme-ai": {
      "upstreamBaseUrl": "https://llm.example.com/v1",
      "headers": {
        "Authorization": { "env": "ACME_API_KEY", "prefix": "Bearer " }
      },
      "registration": {
        "api": "openai-responses",
        "models": [
          {
            "id": "acme-chat",
            "name": "Acme Chat",
            "reasoning": false,
            "input": ["text"],
            "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
            "contextWindow": 128000,
            "maxTokens": 16384
          }
        ]
      }
    }
  }
}
```

Supported adapters are:

- `openai-completions`
- `openai-responses`
- `anthropic-messages`
- `google-generative-ai`

Other wire protocols, OAuth, and token refresh are outside the scope of this package.

## JavaScript API

Use the library API when the host resolves credentials and can keep them in memory.

```ts
import { startModelBroker } from "@pokutuna/pi-model-broker/server";

const broker = await startModelBroker({
  listen: { host: "127.0.0.1", port: 0 },
  providers: {
    openai: {
      upstreamBaseUrl: "https://api.openai.com/v1",
      headers: { Authorization: `Bearer ${openAiApiKey}` },
    },
  },
});

console.log(broker.url);
await broker.close();
```

## Security and scope

- Keep real credentials only in the Broker process environment or memory.
- Do not pass real credentials through `pi`'s environment, `auth.json`, or `--api-key`.
- The Broker listens on loopback and requires HTTPS upstreams.
- Do not put secret literals in the config file.
- Separate UIDs or containers for the Broker and `pi` provide a stronger boundary.

The Broker does not block arbitrary outbound traffic and does not provide a forward proxy,
provider fallback, rate limiting, or billing management. Provide a forward proxy as a separate
host or deployment component when needed.

## Development

```sh
npm run build --workspace=@pokutuna/pi-model-broker
npm run typecheck --workspace=@pokutuna/pi-model-broker
npm test --workspace=@pokutuna/pi-model-broker
```

Tests use fake upstreams rather than real provider APIs and cover the manifest, header injection,
path mapping, redirects, streaming, and extension registration.
