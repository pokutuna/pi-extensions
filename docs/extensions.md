# Building pi-coding-agent extensions

An extension for `pi` (`pi-coding-agent`) is a **TypeScript module**. It can hook into the agent lifecycle and register tools, commands, providers, and other features.

References:

- Official documentation: <https://pi.dev/docs/latest/extensions>
- Local architecture notes: `~/Library/CloudStorage/Dropbox/library/pi-archtecture/extension-points.md` and related files

## File discovery and loading

Extensions are automatically discovered and loaded by `discoverAndLoadExtensions()` from these locations:

| Path | Scope |
| --- | --- |
| `.pi/extensions/*.ts` | Project-local, highest priority after project trust |
| `.pi/extensions/*/index.ts` | Project-local subdirectories; loaded after project trust |
| `~/.pi/agent/extensions/*.ts` | Global |
| `~/.pi/agent/extensions/*/index.ts` | Global subdirectories |
| A path supplied by the CLI or settings | For example, `-e ./path.ts` |

Packages installed with `pi install` are loaded through `~/.pi/agent/settings.json` or `.pi/settings.json`; see [packages.md](packages.md).

Project-local extensions and project package resources are loaded only after the project is trusted. Before trust is resolved, only global extensions and extensions supplied with `-e` can participate in the `project_trust` event.

- `jiti` transpiles TypeScript on the fly, so extensions can be written as plain `.ts` files. Imports are also resolved through `jiti`.
- `/reload` in the TUI and RPC reloads re-read extensions. Some registration APIs, such as `registerProvider`, take effect immediately after the initial load.
- After a session replacement (`newSession`, `fork`, or `switchSession`) or a reload, captured `pi` and `ctx` values may be stale. Use the latest `ctx` passed to each handler.

## Basic structure

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Subscribe to events, register tools and commands, etc.
}
```

The entry point may also be asynchronous, which is useful for fetching remote configuration or discovering models dynamically:

```typescript
export default async function (pi: ExtensionAPI) {
  const response = await fetch("http://localhost:1234/v1/models");
  // ...
}
```

## Registration APIs (`pi.register*`)

### Custom tools: `pi.registerTool()`

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "Description shown to the LLM",
  parameters: Type.Object({
    // TypeBox schema used for validation
    action: StringEnum(["list", "add"] as const),
    text: Type.Optional(Type.String()),
  }),
  promptSnippet: "Short one-line description", // Shown in "Available tools"
  promptGuidelines: [
    "Use my_tool when...",
  ],
  executionMode: "sequential", // Optional: runs the containing batch sequentially
  prepareArguments, // Optional: normalize arguments before validation

  async execute(toolCallId, params, signal, onUpdate, ctx) {
    onUpdate?.({ content: [{ type: "text", text: "Working..." }] });
    return {
      content: [{ type: "text", text: "Done" }],
      details: {/* Persist state or use it in a later tool_result hook */},
    };
  },

  renderCall(args, theme, context) {
    /* Custom TUI rendering for the call */
  },
  renderResult(result, options, theme, context) {
    /* Custom TUI rendering for the result */
  },
});
```

`promptSnippet` is required for the tool to appear in the “Available tools” section, although the tool schema is still available to the LLM without it. `execute` may throw; `pi` converts the error into an `isError` result and sends it back to the LLM without stopping the loop.

### Slash commands: `pi.registerCommand()`

```typescript
pi.registerCommand("stats", {
  description: "Show session statistics",
  handler: async (args, ctx) => {
    const count = ctx.sessionManager.getEntries().length;
    ctx.ui.notify(`${count} entries`, "info");
  },
});
```

If multiple extensions register the same name, they coexist as `/stats:1`, `/stats:2`, and so on.

### Model providers: `pi.registerProvider()` / `pi.unregisterProvider()`

`pi-ai` dispatches requests through a registry keyed by `model.api`. In addition to the nine built-in APIs (`anthropic-messages`, `openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `google-generative-ai`, `google-vertex`, `mistral-conversations`, and `bedrock-converse-stream`), an extension can register a custom API by implementing `streamSimple`.

```typescript
pi.registerProvider("my-proxy", {
  name: "My Proxy",
  baseUrl: "https://proxy.example.com",
  apiKey: "$PROXY_API_KEY", // Read from an environment variable
  api: "anthropic-messages", // Reuse an existing API format
  models: [
    {
      id: "model-id",
      name: "Display Name",
      reasoning: false,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000,
      maxTokens: 16384,
    },
  ],
  // oauth: { name, login, refreshToken, getApiKey },
  // streamSimple: ..., // Implement a completely custom API format
});
```

- Supplying only `baseUrl` is enough to redirect an existing provider through a proxy.
- Existing providers can also be partially overridden.
- `unregisterProvider(name)` restores the built-in provider.
- Calls made after the initial load take effect immediately.

If all you need is one provider at startup, you do not need an extension: add a `providers.<name>` entry with the same schema to `models.json` (`$PI_CODING_AGENT_DIR/models.json`, defaulting to `~/.pi/agent/models.json`). `$ENV_VAR` references in `apiKey` work there as well. Use an extension only when you need runtime branching or code-based features such as `streamSimple` or `oauth`.

### Shortcuts: `pi.registerShortcut()`

```typescript
pi.registerShortcut("ctrl+shift+p", {
  description: "Toggle plan mode",
  handler: async (ctx) => {
    ctx.ui.notify("Toggled!", "info");
  },
});
```

### CLI flags: `pi.registerFlag()` / `pi.getFlag()`

```typescript
pi.registerFlag("plan", {
  description: "Start in plan mode",
  type: "boolean",
  default: false,
});

if (pi.getFlag("plan")) {
  // Plan mode is enabled
}
```

### Message renderers: `pi.registerMessageRenderer()`

Use this API to customize TUI rendering for custom messages that have a `customType`.

## Event hooks (`pi.on(event, handler)`)

Some hooks can modify or stop processing; others are observation-only.

### Lifecycle and sessions

| Event | When it runs | Capabilities |
| --- | --- | --- |
| `resources_discover` | Startup or reload | Return additional skill, prompt, or theme paths |
| `project_trust` | When a trust decision is needed | Return a trust decision |
| `session_start` | Session start | Observe |
| `session_info_changed` | Session name changes | Observe |
| `session_before_switch` | Before `/new` or `/resume` | Cancel |
| `session_before_fork` | Before `/fork` or `/clone` | Cancel or modify |
| `session_before_compact` | Before compaction | Cancel or customize |
| `session_compact` | After compaction | Observe |
| `session_before_tree` / `session_tree` | Before/after tree navigation | Cancel/customize or observe |
| `session_shutdown` | Session shutdown | Observe; useful for cleanup |

### Agent loop (during one prompt)

| Event | When it runs | Capabilities |
| --- | --- | --- |
| `before_agent_start` | Just before the loop starts | Inject messages and modify the system prompt |
| `agent_start` / `agent_end` / `agent_settled` | Agent loop phases | Observe; adding messages in `agent_end` continues the loop |
| `turn_start` / `turn_end` | Turn boundaries | Observe, with `turnIndex` |
| `message_start` / `message_update` | While a message is generated | Observe |
| `message_end` | When a message is finalized | Replace the message in place |
| `tool_execution_start/update/end` | Tool execution phases | Observe; useful for UI rendering |

### Intervention hooks

| Event | When it runs | Capabilities |
| --- | --- | --- |
| `input` | Before user input is expanded | Transform or handle the input |
| `context` | Just before sending messages to the LLM | Modify the entire context; runs every turn |
| `before_provider_headers` | After HTTP headers are built, before sending | Add, replace, or remove request headers |
| `before_provider_request` | After the provider payload is built, before sending | Modify the Anthropic/OpenAI payload |
| `after_provider_response` | After the provider response arrives | Observe status and headers |
| `tool_call` | Just before tool execution, after validation | Block or modify arguments |
| `tool_result` | After tool execution | Modify `content`, `details`, or `isError` |
| `user_bash` | When the user runs `!cmd` | Intervene |
| `model_select` / `thinking_level_select` | When the model or thinking level changes | Observe |

The `project_trust` handler must return `{ trusted: "yes" | "no" | "undecided" }`. Use `{ remember: true }` to persist a yes/no decision, and check `ctx.hasUI` before prompting in non-interactive modes.

The repository currently pins `@earendil-works/pi-coding-agent` 0.80.3. `before_provider_headers` is available in newer pi versions; check the installed version before using it.

Returning `{ block: true }` from `tool_call` skips execution and creates an error result. If a `tool_call` or `tool_result` handler throws, the tool is blocked, but the agent loop continues and the error is returned to the LLM as an `isError` result.

Example:

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (isToolCallEventType("bash", event)) {
    if (event.input.command.includes("rm -rf")) {
      return { block: true, reason: "Blocked dangerous command" };
    }
  }
});

pi.on("before_agent_start", async (event, ctx) => {
  return {
    systemPrompt: event.systemPrompt + "\nAdditional instructions",
    message: {
      customType: "my-ext",
      content: "Additional context for the LLM",
    },
  };
});
```

## `ExtensionContext` (`ctx`)

The main properties available to handlers, tools, and commands are:

| Property | Description |
| --- | --- |
| `ctx.ui` | User interaction, such as dialogs and notifications |
| `ctx.mode` | Execution mode: `"tui"`, `"rpc"`, `"json"`, or `"print"` |
| `ctx.hasUI` | Whether interactive UI is available |
| `ctx.cwd` | Current working directory |
| `ctx.sessionManager` | Read session state |
| `ctx.signal` | Cancellation signal |
| `ctx.isIdle()` | Check whether the agent is idle |
| `ctx.isProjectTrusted()` | Check whether the current directory is trusted |
| `ctx.compact()` | Trigger compaction |
| `ctx.shutdown()` | Gracefully shut down |

Command handlers receive additional `ExtensionCommandContext` methods:

```typescript
ctx.waitForIdle(); // Wait until the agent is completely idle
ctx.newSession(); // Create a new session
ctx.fork(entryId); // Fork from an entry
ctx.navigateTree(targetId); // Navigate the session tree
ctx.switchSession(path); // Switch sessions
ctx.reload(); // Reload resources
```

### UI operations

```typescript
ctx.ui.notify("Message", "info" | "error" | "warning");
ctx.ui.confirm("Title", "Question"); // Returns a boolean
ctx.ui.select("Title", ["Choice 1", "Choice 2"]);
ctx.ui.input("Title", "Default value");
ctx.ui.setStatus("widget-id", "Status text");
ctx.ui.setWidget("widget-id", ["Line 1", "Line 2"]);
ctx.ui.custom(component); // Custom pi-tui component
```

## Action APIs

These APIs let an extension actively control the session from a hook:

```typescript
pi.sendMessage(
  { customType: "my-ext", content: "Text", display: true },
  { triggerTurn: true, deliverAs: "steer" } // "steer" | "followUp" | "nextTurn"
);

pi.sendUserMessage("User message", { deliverAs: "steer" });

pi.appendEntry("my-state", { count: 42 }); // Persist outside the LLM context

pi.setSessionName("Session name");
pi.setLabel(entryId, "checkpoint-label");

pi.getAllTools();
pi.getActiveTools();
pi.setActiveTools(["read", "bash"]); // Change active tools dynamically

pi.setModel(...);
pi.setThinkingLevel(...);

pi.exec(...); // Run a shell command
pi.events; // Shared EventBus for communication between extensions
```

## Queueing file mutations

Use `withFileMutationQueue` to safely edit the same file from multiple tools:

```typescript
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";

const absolutePath = resolve(ctx.cwd, params.path);
return withFileMutationQueue(absolutePath, async () => {
  const content = await readFile(absolutePath, "utf8");
  const updated = content.replace(oldText, newText);
  await writeFile(absolutePath, updated, "utf8");
  return { content: [...], details: {} };
});
```

## Persisting state

A common pattern is to store session-specific state in a tool result’s `details` and restore it from `sessionManager` on `session_start`:

```typescript
let state: MyState = {};

pi.on("session_start", async (_event, ctx) => {
  state = {};
  for (const entry of ctx.sessionManager.getBranch()) {
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      entry.message.toolName === "my_tool"
    ) {
      state = entry.message.details?.state ?? {};
    }
  }
});

return {
  content: [...],
  details: { state: { ...state } },
};
```

Sessions are persisted as append-only JSON Lines files (`<timestamp>_<sessionId>.jsonl`), with each message written by `appendMessage`. Custom entries written with `appendEntry` are not included in the LLM context.

## Complex extensions with `package.json`

An extension with npm dependencies can be organized as a directory with a `package.json`:

```json
{
  "name": "my-extension",
  "dependencies": {
    "zod": "^3.0.0"
  },
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

```
~/.pi/agent/extensions/my-extension/
├── package.json
├── src/
│   ├── index.ts   (extension entry point, default export)
│   ├── tools.ts   (tool definitions)
│   └── utils.ts   (utilities)
└── node_modules/
```

## Available imports

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
```

Node.js built-ins such as `node:fs` and `node:path` are also available. Because imports are loaded through `jiti`, npm dependencies can be used directly from TypeScript. For distributed packages, runtime dependencies must be in `dependencies`; pi installs packages with production dependencies by default, so `devDependencies` are not available at runtime.

## Hook flow at a glance

```
Input       → input (intercept/transform before expansion)
            → before_agent_start (inject messages, modify system prompt)
Before LLM  → context (modify messages)
            → before_provider_headers (modify request headers)
            → before_provider_request (modify payload)
After LLM   → after_provider_response (observe status/headers)
Before tool → tool_call (block/modify arguments)
After tool  → tool_result (modify result)
Message     → message_end (replace message)
Registration→ tool / command / shortcut / flag / provider / renderer
```

Most extension events are adapted and forwarded by the host’s `AgentSession`. Intervention hooks such as `tool_call`, `tool_result`, `context`, and `before_provider_request` are connected directly to dedicated hooks in the agent core.

## Distributing extensions in a monorepo

For multiple extensions in one repository, an npm-workspaces monorepo is a practical structure. The following is an example based on an external repository; this repository uses `pi-google-genai` and `pi-hello`.

```
pi-extensions/
├── package.json          # Root package; workspaces: ["extensions/*"]
├── package-lock.json
├── biome.json            # Lint/format configuration
├── tsconfig.json         # Shared TypeScript configuration
├── justfile              # Common commands
├── scripts/              # Boundary checks, tests, and version helpers
├── docs/
└── extensions/
    ├── pi-goal/
    │   ├── package.json  # "pi": { "extensions": ["./src/goal.ts"] }
    │   ├── tsconfig.json
    │   ├── README.md
    │   ├── LICENSE
    │   ├── src/*.ts
    │   └── test/*.test.ts
    ├── pi-caffeinate/
    ├── pi-lsp/
    └── ...
```

Each extension is an independent npm package, with its entry point declared in `pi.extensions`:

```json
{
  "name": "@scope/pi-goal",
  "pi": { "extensions": ["./src/goal.ts"] },
  "files": ["src", "README.md", "LICENSE"]
}
```

The root `package.json` can run commands across all workspaces, while a shared `tsconfig.json` keeps compiler settings consistent. A dependency-boundary check can prevent accidental imports between packages. A `just` task runner can parameterize `try`, `install`, `publish`, and `pack` commands by extension name.

For package installation details—including accepted sources, Git subdirectory limitations, manifest discovery, and dependency rules—see [packages.md](packages.md).

## Build or publish TypeScript directly?

Because `pi` transpiles `.ts` files with `jiti`, npm packages can publish `src/*.ts` without a build step. Extensions with many external dependencies may instead bundle into `dist/` with `tsup` or `tsdown` to make dependency resolution more self-contained.

| Approach | Example | `pi.extensions` | `files` |
| --- | --- | --- | --- |
| Publish source directly | Most of the external `narumiruna/pi-extensions` example | `["./src/index.ts"]` | `["src", "README.md"]` |
| Publish a bundle | Official `pi-smart-fetch`, this repository’s `pi-google-genai` | `["./dist/index.mjs"]` | `["dist", "README.md"]` |

This repository uses `tsdown` (`extensions/pi-google-genai/tsdown.config.ts`). Run `npm run build` (`npm --workspaces run build --if-present`) to build all packages; each published package’s `prepublishOnly` hook also builds it before `npm publish`.

## Debugging and local testing

### Load a file or directory with `pi -e`

```bash
# Load a single extension file
pi -e ./path/to/my-extension.ts

# Load a package directory using its package.json manifest
pi -e ./extensions/pi-google-genai

# Load multiple extensions
pi -e ./extensions/pi-google-genai -e ./extensions/pi-hello
```

`-e`/`--extension` is independent of normal discovery. Use `--no-extensions`/`-ne` to disable automatic discovery while still loading explicitly specified extensions:

```bash
pi -ne -e ./extensions/pi-google-genai
```

In a monorepo, all extensions can be passed explicitly:

```bash
args=(); for dir in ./extensions/pi-*; do args+=(-e "$dir"); done
pi -ne "${args[@]}"
```

### Test with `just`

For a repository such as `narumiruna/pi-extensions`:

```bash
just try goal        # Start pi with ./extensions/pi-goal
just try-all         # Start pi with all extensions
just install goal     # Install from npm, or fall back to the local workspace
just pack goal        # Preview package contents with npm publish --dry-run
```

### Automate TUI testing with tmux

TUI-only behavior such as `ctx.ui.notify` is not visible in print, JSON, or RPC mode. `tmux` can start a TUI session from a non-interactive environment and capture its output:

```bash
tmux new-session -d -s pi-test -x 200 -y 50 "pi -ne -e ./extensions/pi-hello --no-session"
sleep 3
tmux capture-pane -t pi-test -p

tmux send-keys -t pi-test "/hello World" Enter
sleep 1
tmux capture-pane -t pi-test -p

tmux send-keys -t pi-test C-c
tmux send-keys -t pi-test C-c
tmux kill-session -t pi-test
```

`--no-session` avoids leaving a session file behind. Combining `-ne` with `-e <path>` ensures that only the target extension is loaded.
