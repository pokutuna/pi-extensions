import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import {
  describeAuth,
  loadConfig,
  resolveAuth,
  type LoadedConfig,
} from "./config.ts";
import { cleanupRawResponseDirectory } from "./format.ts";
import {
  createDeepResearchTool,
  googleMapsTool,
  googleSearchTool,
  urlContextTool,
} from "./tools.ts";

const STATUS_KEY = "google-genai";

export default function googleGenai(pi: ExtensionAPI) {
  pi.registerTool(googleSearchTool);
  pi.registerTool(googleMapsTool);
  pi.registerTool(urlContextTool);
  pi.registerTool(createDeepResearchTool(pi));

  pi.registerCommand("google-genai", {
    description: "Show Google GenAI grounding tools status",
    handler: async (args, ctx) => {
      await handleCommand(args, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const loaded = await loadConfig();
    if (loaded.warnings.length > 0) {
      ctx.ui.notify(loaded.warnings.join("\n"), "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
    await cleanupRawResponseDirectory();
  });
}

type CommandAction = "status" | "help" | "unknown";

export function parseCommand(rawArgs: string): CommandAction {
  const [command = ""] = rawArgs.trim().split(/\s+/).filter(Boolean);
  switch (command) {
    case "":
    case "status":
      return "status";
    case "help":
      return "help";
    default:
      return "unknown";
  }
}

async function handleCommand(rawArgs: string, ctx: ExtensionCommandContext) {
  switch (parseCommand(rawArgs)) {
    case "status": {
      const loaded = await loadConfig();
      ctx.ui.notify(await buildStatusMessage(loaded, ctx), "info");
      return;
    }
    case "help":
      ctx.ui.notify(helpText(), "info");
      return;
    case "unknown":
      ctx.ui.notify(helpText(), "warning");
      return;
  }
}

export async function buildStatusMessage(
  loaded: LoadedConfig,
  ctx: ExtensionCommandContext,
): Promise<string> {
  let auth: string;
  try {
    auth = describeAuth(
      await resolveAuth(loaded.config, process.env, ctx.modelRegistry),
    );
  } catch (error) {
    auth = `unresolved — ${error instanceof Error ? error.message : String(error)}`;
  }
  return [
    "Google GenAI status:",
    `config: ${loaded.path}`,
    `configLoaded: ${loaded.configLoaded ? "yes" : "no"}`,
    `auth: ${auth}`,
    `model: ${loaded.config.model}`,
    `timeoutMs: ${loaded.config.timeoutMs}`,
    ...(loaded.warnings.length > 0
      ? ["warnings:", ...loaded.warnings.map((warning) => `- ${warning}`)]
      : []),
  ].join("\n");
}

function helpText(): string {
  return [
    "Google GenAI grounding tools (google_search, google_maps, url_context, deep_research).",
    "",
    "Usage:",
    "/google-genai [status] - show config path, auth backend, model, and warnings",
    "/google-genai help - show this help",
    "",
    "Configuration (all optional): ~/.pi/agent/google-genai.json",
    '{ "auth": "api-key" | "vertex-ai", "apiKey": "...", "project": "...",',
    '  "location": "global", "model": "gemini-3.5-flash", "timeoutMs": 60000 }',
    "",
    "Auth: GEMINI_API_KEY / GOOGLE_API_KEY / /login google, or Vertex AI via",
    "`gcloud auth application-default login` + GOOGLE_CLOUD_PROJECT.",
  ].join("\n");
}
