# pi-google-genai — Design

A [pi](https://pi.dev) extension that exposes Google GenAI grounding capabilities
(Google Search, Google Maps, URL context) as agent tools, built on the official
[`@google/genai`](https://github.com/googleapis/js-genai) SDK.

## Goals

- Provide grounding tools: `google_search`, `google_maps`, `url_context`, plus
  `deep_research` for agentic multi-step research.
- Support **both** authentication backends of Google GenAI:
  - **Gemini Developer API** with an API key.
  - **Vertex AI** with Application Default Credentials (ADC).
- Default model: `gemini-3.5-flash`, overridable via config.
- Format responses with structured source citations extracted from grounding
  metadata, truncated safely for the agent context.

## Non-goals (for now)

- Interactive config wizard (`init`) — configuration is a JSON file plus
  environment variables.
- Per-tool enable/disable UI — pi core already manages active tools.

## Why `@google/genai`

Community pi extensions in this space call the raw REST endpoints directly.
Using the official SDK instead gives us:

- One client that speaks to both the Gemini Developer API and Vertex AI,
  selected by constructor options (`{ apiKey }` vs.
  `{ vertexai: true, project, location }`).
- ADC handling (service accounts, `gcloud auth application-default login`,
  workload identity) for free via `google-auth-library`.
- Typed request/response surfaces (`groundingMetadata`, `urlContextMetadata`,
  `toolConfig`) instead of hand-rolled JSON parsing.
- Abort signal and per-request timeout support (`config.abortSignal`,
  `httpOptions.timeout`).

## Tools

All three tools call `ai.models.generateContent()` with a single
grounding tool attached and return the model's synthesized answer plus a
`Sources:` section.

### `google_search`

Search-grounded question answering.

| Parameter     | Type     | Notes                                                        |
| ------------- | -------- | ------------------------------------------------------------- |
| `query`       | string   | Required. The search question.                                |
| `searchTypes` | string[] | Optional. `"web_search"` and/or `"image_search"`. Defaults to web search only. |
| `timeoutMs`   | integer  | Optional. Per-call override of the timeout.                   |

Request: `tools: [{ googleSearch: {} }]`, or `tools: [{ googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } }]`
when `searchTypes` selects one or both grounding modes.

### `google_maps`

Maps-grounded question answering (places, nearby, routes, local businesses).

| Parameter   | Type    | Notes                                                |
| ----------- | ------- | ---------------------------------------------------- |
| `query`     | string  | Required.                                            |
| `latitude`  | number  | Optional. Must be paired with `longitude`. -90..90.  |
| `longitude` | number  | Optional. Must be paired with `latitude`. -180..180. |
| `timeoutMs` | integer | Optional.                                            |

Request: `tools: [{ googleMaps: {} }]`; when a location is given it is passed
as `toolConfig.retrievalConfig.latLng`.

### `url_context`

Ask Gemini a question using specific URLs as context.

| Parameter   | Type     | Notes                                          |
| ----------- | -------- | ---------------------------------------------- |
| `prompt`    | string   | Required. Question/instruction about the URLs. |
| `urls`      | string[] | Required, 1–20 http/https URLs.                |
| `timeoutMs` | integer  | Optional.                                      |

Request: `tools: [{ urlContext: {} }]`, with the URLs appended to the prompt.

Exact request field names follow the installed `@google/genai` type
definitions; the tables above describe intent, not the wire format.

### `deep_research`

Agentic multi-step research via Gemini's Deep Research (Vertex AI backend
only, using the `@google/genai` Interactions API — `ai.interactions`, a
separate surface from `ai.models.generateContent()`). Empirically, a real
research topic takes anywhere from several minutes to tens of minutes to
complete, growing through dozens of internal steps.

That duration rules out `generateGrounded()`'s one-shot-with-timeout model:
no single tool call can block for that long. Instead:

| Parameter       | Type   | Notes                                                        |
| --------------- | ------ | ------------------------------------------------------------- |
| `query`         | string | Start a new run. Omit when checking an existing one.          |
| `interactionId` | string | Check a previously started run instead of starting a new one. |

- **Starting a run** (`query` given): create the interaction
  (`ai.interactions.create({ agent, input, background: true })`) and return
  immediately with its `interactionId` — the tool call does not wait.
  A detached background poll (a `setTimeout` loop inside the extension
  process, independent of any tool call's lifetime) checks the interaction
  every `POLL_INTERVAL_MS` and, once it reaches a terminal status
  (`completed`/`failed`/`cancelled`/`incomplete`/`budget_exceeded`), delivers
  the result into the conversation via `pi.sendMessage(..., { triggerTurn:
  true, deliverAs: "nextTurn" })`. This requires capturing `pi` at extension
  registration time and threading it into the tool (`createDeepResearchTool(pi)`),
  since `pi` is not part of a tool's `execute()` arguments.
- **Bounds on the poll**: the loop stops — and says so via `pi.sendMessage` —
  after `MAX_CONSECUTIVE_ERRORS` (10) failed reads in a row, or once
  `MAX_POLL_DURATION_MS` (2h) has elapsed. Both are escape hatches for an
  interaction that can never resolve (deleted id, revoked credentials), not
  caps on normal runs, which finish in minutes. A successful read resets the
  error counter. `session_shutdown` calls `cancelBackgroundPolls()` to clear
  any pending timers.
- **Checking a run** (`interactionId` given): a single non-blocking
  `ai.interactions.get(id)` call, for on-demand status checks; this path does
  not start another background poll (only `startDeepResearch` does).
- The agent is instructed (via `promptGuidelines`) to start a run once and
  then wait for the announced message rather than repeatedly calling
  `deep_research` to poll — polling via tool calls would cost many round
  trips for a job that runs for minutes.
- The final answer is extracted from the last `model_output` step's text
  content in the completed interaction's `steps` array.
- `deep_research` requires the `vertex-ai` auth backend and throws an
  actionable error otherwise; it was empirically confirmed to work against
  Vertex AI with ADC (the public docs do not call out Vertex AI support
  explicitly).

## Configuration

Single JSON config file:

```
$PI_CODING_AGENT_DIR/google-genai.json   (default: ~/.pi/agent/google-genai.json)
```

```jsonc
{
  // "api-key" | "vertex-ai". Omit to auto-detect.
  "auth": "vertex-ai",

  // api-key backend. Literal value only (no $ENV / command interpolation).
  "apiKey": "...",

  // vertex-ai backend
  "project": "my-gcp-project",
  "location": "global",

  "model": "gemini-3.5-flash",
  "timeoutMs": 60000,
}
```

All fields are optional. Unknown fields and invalid values produce warnings
(surfaced via `ctx.ui.notify` on session start) and fall back to defaults,
never hard failures at load time.

### Defaults

| Setting     | Default            |
| ----------- | ------------------ |
| `model`     | `gemini-3.5-flash` |
| `location`  | `global`           |
| `timeoutMs` | `60000`            |

`timeoutMs` accepts an integer from 1 to `MAX_TIMEOUT_MS` (600000, i.e. 10
minutes) — a bound on what a single grounded call can plausibly need, not on
`deep_research`, which is not a blocking call and has its own poll bounds.

### Resolution precedence

For every setting: **config file > environment variables > pi auth registry >
default**. The environment variables honored are the ones the SDK ecosystem
already uses:

| Variable                    | Meaning                                 |
| --------------------------- | --------------------------------------- |
| `GOOGLE_GENAI_USE_VERTEXAI` | Truthy → select the `vertex-ai` backend |
| `GEMINI_API_KEY`            | API key                                 |
| `GOOGLE_API_KEY`            | API key (lower precedence than above)   |
| `GOOGLE_CLOUD_PROJECT`      | Vertex AI project                       |
| `GOOGLE_CLOUD_LOCATION`     | Vertex AI location                      |

## Authentication

Resolution runs per tool call and follows this algorithm. The config file is
re-read every time — deliberately, so edits to `google-genai.json` take effect
on the next tool call without restarting pi. It costs ~0.02ms against a
multi-second API call, so there is nothing to gain by caching it. Only the
`GoogleGenAI` client is memoized, keyed on the resolved auth (the api-key
backend is keyed by a SHA-256 digest, so the memo entry holds no key material):

1. **Backend selection**
   1. `config.auth` if set.
   2. `GOOGLE_GENAI_USE_VERTEXAI` truthy → `vertex-ai`.
   3. Auto-detect: if an API key is resolvable → `api-key`;
      else if a project is resolvable → `vertex-ai`;
      else fail with a message listing every way to configure auth.
2. **`api-key` backend** — resolve the key from, in order:
   `config.apiKey` → `GEMINI_API_KEY` → `GOOGLE_API_KEY` →
   pi's provider auth (`ctx.modelRegistry.getApiKeyForProvider("google")`,
   i.e. `/login google`). Client: `new GoogleGenAI({ apiKey })`.
3. **`vertex-ai` backend** — resolve `project` (config →
   `GOOGLE_CLOUD_PROJECT`; required) and `location` (config →
   `GOOGLE_CLOUD_LOCATION` → `"global"`). Client:
   `new GoogleGenAI({ vertexai: true, project, location })`.
   Credentials come from ADC; the extension never touches key material.

Auth errors thrown from `execute()` are returned to the model as tool errors
with actionable guidance (which env var / config field / `gcloud` command to
use), so the agent reports the problem instead of retrying blindly.

## Request flow

```
tool execute()
  → validate params (paired lat/lng, url scheme, timeout range)
  → load config + resolve auth  → memoized GoogleGenAI client
  → generateContent({ model, contents, config: { tools, toolConfig?,
      abortSignal, httpOptions: { timeout } } })
  → format result (text + sources, truncation)
```

- **Timeout**: per-call `timeoutMs` param > config `timeoutMs` > 60s default.
  Passed both as `httpOptions.timeout` and enforced with an `AbortSignal`
  combined with pi's cancellation signal, so user cancellation always wins.
  Timeout errors say explicitly that they are timeouts (not empty results) and
  suggest narrowing the query before raising the timeout.
- **Status**: `ctx.ui.setStatus("google-genai", ...)` while a call is in
  flight, cleared in `finally`.

## Response formatting

From the `GenerateContentResponse`:

1. **Answer text** — `response.text`.
2. **Sources** — deduplicated, capped list built from:
   - `groundingMetadata.groundingChunks` — web results (`title`, `uri`) and
     maps results (`title`, `uri`, `placeId`);
   - `urlContextMetadata.urlMetadata` — retrieved URL + retrieval status.
3. **Truncation** — the combined text is truncated with pi's `truncateHead`
   using `DEFAULT_MAX_LINES` / `DEFAULT_MAX_BYTES`. When truncated, the full
   raw response is written to a session-scoped temp directory (0700, cleaned
   up on `session_shutdown`) and the path is included in the footer so the
   agent can `read` it.
4. **Details** — the tool result `details` carries the model used, source
   list, and truncation info for renderers and hooks.

## Command

`/google-genai` (alias args: `status`, `help`):

- `status` (default) — config path, whether the file loaded, resolved backend
  and its source (config / env / pi auth / ADC), model, timeout, warnings.
  Never prints key material.
- `help` — usage and configuration instructions.

## Package layout

```
extensions/pi-google-genai/
├── package.json          # deps: @google/genai, typebox; pi.extensions → dist
├── tsconfig.json         # extends ../../tsconfig.json
├── tsdown.config.ts      # entry src/index.ts, esm
├── DESIGN.md
├── README.md
├── src/
│   ├── index.ts          # default export: register tools + command + hooks
│   ├── config.ts         # config load/normalize, auth resolution
│   ├── client.ts         # memoized GoogleGenAI factory, generateContent call,
│   │                     #   timeout/abort handling
│   ├── tools.ts          # the three tool definitions + param validation
│   └── format.ts         # response → tool result (text, sources, truncation)
└── test/
    ├── config.test.ts    # normalization, precedence, auth resolution
    ├── tools.test.ts     # param validation
    └── format.test.ts    # source extraction, truncation
```

Build follows the repo convention: bundled with tsdown into `dist/`,
`@google/genai` and `typebox` stay external as regular dependencies, and
`@earendil-works/pi-coding-agent` stays external as a dev dependency (provided
by the pi runtime at load time). Tests run on Node's built-in test runner
(type stripping, no extra tooling).

## Error handling

- Config problems are warnings, not failures; tools still run with defaults.
- Missing/invalid auth throws from `execute()` with setup instructions.
- SDK/API errors are rethrown with the HTTP status and the API's error message.
- `execute()` may throw freely — pi converts throws into `isError` tool
  results without breaking the agent loop.

## Future work

- Per-tool model overrides if a use case appears (e.g. cheaper model for
  `url_context`).
- Persist in-flight `deep_research` interaction ids across a session restart
  (currently the background poll only lives as long as the extension
  process; a restart loses track of runs still in progress on the server).
