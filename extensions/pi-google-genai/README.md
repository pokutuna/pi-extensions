# @pokutuna/pi-google-genai

A [pi](https://pi.dev) extension that adds Google GenAI grounding tools, built
on the official [`@google/genai`](https://github.com/googleapis/js-genai) SDK.

## Tools

| Tool             | What it does                                                     |
| ---------------- | ---------------------------------------------------------------- |
| `google_search`  | Search-grounded question answering via Google Search             |
| `google_maps`    | Maps-grounded answers (places, nearby, routes, local businesses) |
| `url_context`    | Ask Gemini a question using specific http/https URLs as context  |
| `deep_research`  | Agentic multi-step research via Gemini Deep Research (Vertex AI only) |

Grounding tools return the model's synthesized answer plus a `Sources:`
section. Long outputs are truncated; the full raw response is saved to a
session-scoped temp file.

`google_search` accepts an optional `searchTypes` array (`"web_search"` and/or
`"image_search"`). Some models do not support image search grounding.

`deep_research` starts Gemini's Deep Research agent and returns an
`interactionId`; it typically takes several minutes to finish. Use the ID
without `query` to check its status. It is available only with Vertex AI.

Default model: `gemini-3.6-flash`; Vertex AI location defaults to `global`.

## Authentication

### Gemini Developer API (API key)

Use either of these environment variables:

```sh
export GEMINI_API_KEY=your-key      # or GOOGLE_API_KEY
```

Alternatively, set `apiKey` in the config file. Pi's `/login google` credential
is used when `lookupPiConfig` is `true`.

### Vertex AI (Application Default Credentials)

Vertex AI authentication uses Application Default Credentials (ADC). For
local development, authenticate with:

```sh
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=my-gcp-project
# optional, defaults to "global"
export GOOGLE_CLOUD_LOCATION=us-central1
```

See the [Application Default Credentials documentation](https://docs.cloud.google.com/docs/authentication/application-default-credentials)
for other setup options. This is also the required backend for
`deep_research`.

Set `GOOGLE_GENAI_USE_VERTEXAI=true` or `"auth": "vertex-ai"` to force Vertex
AI. Otherwise, an API key takes precedence when both are available.

## Configuration

Optional JSON file: `~/.pi/agent/google-genai.json` (or
`$PI_CODING_AGENT_DIR/google-genai.json` if set).

```json
{
  "auth": "vertex-ai",
  "project": "my-gcp-project",
  "model": "gemini-3.6-flash",
  "lookupPiConfig": false
}
```

Config values override environment variables. Unknown or invalid fields produce
warnings. `apiKey` must be a literal value; `$ENV_VAR` and command
interpolation are not supported.

To enable lookup of pi's Google configuration, use:

```json
{
  "lookupPiConfig": true
}
```

### Pi configuration lookup

`lookupPiConfig` defaults to `false`; the extension then uses only its own
settings and environment variables. Set it to `true` to use pi's current
Google provider and credentials:

- current provider `google` uses pi's Google API key;
- current provider `google-vertex` uses Vertex AI;
- pi's `google` / `google-vertex` credentials, including
  `GOOGLE_CLOUD_API_KEY`, are used when available;
- if no Google provider is active, Gemini API authentication is preferred over
  Vertex AI authentication.

Explicit settings in `google-genai.json` still take precedence.

## Command

- `/google-genai` or `/google-genai status` — show the resolved configuration
  (never the key itself) and any warnings.
- `/google-genai help` — usage and configuration instructions.
