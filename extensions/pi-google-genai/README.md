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

`google_search`, `google_maps`, and `url_context` return the model's
synthesized answer plus a `Sources:` section extracted from the grounding
metadata. Long outputs are truncated; the full raw response is saved to a
session-scoped temp file whose path is included in the output.

`google_search` accepts an optional `searchTypes` array (`"web_search"`
and/or `"image_search"`) to enable image search grounding alongside or
instead of web search. Image search grounding is not supported by every
model; the API returns an explicit error when the configured model rejects
it.

`deep_research` runs Gemini's Deep Research agent, which typically takes
several minutes to tens of minutes to finish. It requires the `vertex-ai`
auth backend. Calling it with a `query` starts a run and returns immediately
with an `interactionId`; the result is announced back into the conversation
once the run finishes, so there's no need to poll by calling the tool again.
Pass `interactionId` (without `query`) to check a run's status on demand.

Default model: `gemini-3.5-flash`.

## Authentication

Two backends are supported and auto-detected:

### Gemini Developer API (API key)

Any of the following works:

```sh
export GEMINI_API_KEY=your-key      # or GOOGLE_API_KEY
```

or run `/login google` in pi, or set `apiKey` in the config file below.

### Vertex AI (Application Default Credentials)

```sh
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=my-gcp-project
# optional, defaults to "global"
export GOOGLE_CLOUD_LOCATION=us-central1
```

Setting `GOOGLE_GENAI_USE_VERTEXAI=true` (or `"auth": "vertex-ai"` in the
config) forces the Vertex AI backend; otherwise an API key takes precedence
when both are available.

## Configuration

Optional JSON file at `~/.pi/agent/google-genai.json`
(`$PI_CODING_AGENT_DIR/google-genai.json` if set). All fields are optional:

```json
{
  "auth": "vertex-ai",
  "apiKey": "literal-api-key-only",
  "project": "my-gcp-project",
  "location": "global",
  "model": "gemini-3.5-flash",
  "timeoutMs": 60000
}
```

Config file values take precedence over environment variables. Invalid or
unknown fields produce warnings and fall back to defaults. `apiKey` must be a
literal value; `$ENV_VAR` or command interpolation is not supported.

## Command

- `/google-genai` (or `/google-genai status`) — show config path, resolved
  auth backend and its source (never the key itself), model, timeout, and any
  config warnings.
- `/google-genai help` — usage and configuration instructions.
