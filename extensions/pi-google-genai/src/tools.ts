import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { generateGrounded } from "./client.ts";
import { DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS } from "./config.ts";
import {
  checkDeepResearch,
  startDeepResearch,
  type DeepResearchResult,
} from "./deep-research.ts";

const STATUS_KEY = "google-genai";
const MAX_URLS = 20;
const TRUNCATION_NOTE = `Output is truncated to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`;
const AUTH_GUIDELINE =
  "If Google GenAI auth is missing or invalid, report the configuration error instead of retrying.";
const SEARCH_TYPES = ["web_search", "image_search"] as const;
type SearchType = (typeof SEARCH_TYPES)[number];

const SearchTypesParameter = Type.Optional(
  Type.Array(
    Type.Union([Type.Literal("web_search"), Type.Literal("image_search")]),
    {
      description:
        "Optional Google Search grounding types to enable. Defaults to web search only. " +
        'Include "image_search" to also ground on image search results ' +
        "(not supported by every model; the API returns an explicit error if the configured model rejects it).",
    },
  ),
);

const TimeoutMsParameter = Type.Optional(
  Type.Integer({
    description:
      `Per-call timeout in milliseconds. Overrides google-genai.json timeoutMs and the ` +
      `${DEFAULT_TIMEOUT_MS}ms default. Must be an integer from 1 to ${MAX_TIMEOUT_MS}.`,
    minimum: 1,
    maximum: MAX_TIMEOUT_MS,
  }),
);

export function validateTimeoutMs(timeoutMs: unknown): number | undefined {
  if (timeoutMs === undefined) return undefined;
  if (
    typeof timeoutMs !== "number" ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_TIMEOUT_MS
  ) {
    throw new Error(
      `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return timeoutMs;
}

export function validateSearchTypes(
  searchTypes: unknown,
): SearchType[] | undefined {
  if (searchTypes === undefined) return undefined;
  if (!Array.isArray(searchTypes))
    throw new Error("searchTypes must be an array.");
  const values = [...new Set(searchTypes)];
  for (const value of values) {
    if (!(SEARCH_TYPES as readonly unknown[]).includes(value)) {
      throw new Error(`searchTypes supports only: ${SEARCH_TYPES.join(", ")}.`);
    }
  }
  return values as SearchType[];
}

export function validateMapsLocation(params: {
  latitude?: unknown;
  longitude?: unknown;
}): { latitude: number; longitude: number } | undefined {
  const hasLatitude = params.latitude !== undefined;
  const hasLongitude = params.longitude !== undefined;
  if (hasLatitude !== hasLongitude) {
    throw new Error("latitude and longitude must be provided together.");
  }
  if (!hasLatitude) return undefined;
  if (
    typeof params.latitude !== "number" ||
    !Number.isFinite(params.latitude)
  ) {
    throw new Error("latitude must be a finite number.");
  }
  if (
    typeof params.longitude !== "number" ||
    !Number.isFinite(params.longitude)
  ) {
    throw new Error("longitude must be a finite number.");
  }
  if (params.latitude < -90 || params.latitude > 90) {
    throw new Error("latitude must be between -90 and 90.");
  }
  if (params.longitude < -180 || params.longitude > 180) {
    throw new Error("longitude must be between -180 and 180.");
  }
  return { latitude: params.latitude, longitude: params.longitude };
}

export function validateUrls(urls: unknown): string[] {
  if (!Array.isArray(urls) || urls.length === 0) {
    throw new Error("urls must contain at least one http:// or https:// URL.");
  }
  if (urls.length > MAX_URLS) {
    throw new Error(`urls supports at most ${MAX_URLS} URLs per call.`);
  }
  return urls.map((url) => {
    if (typeof url !== "string" || !url.trim()) {
      throw new Error("urls must contain non-empty strings.");
    }
    const trimmed = url.trim();
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      throw new Error(`Invalid URL: ${url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Only http:// and https:// URLs are supported: ${url}`);
    }
    return trimmed;
  });
}

function toGoogleSearchTool(searchTypes: SearchType[] | undefined) {
  if (!searchTypes) return {};
  return {
    searchTypes: {
      ...(searchTypes.includes("web_search") ? { webSearch: {} } : {}),
      ...(searchTypes.includes("image_search") ? { imageSearch: {} } : {}),
    },
  };
}

export const googleSearchTool = defineTool({
  name: "google_search",
  label: "Google GenAI: Search",
  description: `Answer a question using Google Search grounding, via Gemini. ${TRUNCATION_NOTE}`,
  promptSnippet: "Search the web through Gemini's Google Search grounding",
  promptGuidelines: [
    "Use for current public web info a search engine would answer; not for content behind a specific URL (use url_context) or place/map questions (use google_maps).",
    "For broad or multi-part questions, ask narrow, single-topic queries and combine results yourself rather than one broad call.",
    AUTH_GUIDELINE,
  ],
  parameters: Type.Object({
    query: Type.String({ description: "Search question or query." }),
    searchTypes: SearchTypesParameter,
    timeoutMs: TimeoutMsParameter,
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const searchTypes = validateSearchTypes(params.searchTypes);
    const timeoutMs = validateTimeoutMs(params.timeoutMs);
    return withStatus(ctx, "search", () =>
      generateGrounded(
        {
          contents: params.query,
          tools: [{ googleSearch: toGoogleSearchTool(searchTypes) }],
          timeoutMs,
          timeoutAdvice:
            "Broad trend, comparison, or review-synthesis queries can time out; " +
            "narrow the query or split it into smaller google_search calls before raising the timeout.",
        },
        ctx,
        signal,
      ),
    );
  },
});

export const googleMapsTool = defineTool({
  name: "google_maps",
  label: "Google GenAI: Maps",
  description: `Answer a place, nearby, route, or local-business question using Google Maps grounding, via Gemini. ${TRUNCATION_NOTE}`,
  promptSnippet: "Ask Google Maps-grounded questions through Gemini",
  promptGuidelines: [
    "Use for places, nearby search, routes, and local businesses.",
    'Pass latitude and longitude together when the user\'s own location matters (e.g. "near me"); omit both for a named place or area.',
    AUTH_GUIDELINE,
  ],
  parameters: Type.Object({
    query: Type.String({
      description: "Maps-grounded question or place query.",
    }),
    latitude: Type.Optional(
      Type.Number({
        description:
          "User latitude in degrees (-90 to 90). Requires longitude.",
      }),
    ),
    longitude: Type.Optional(
      Type.Number({
        description:
          "User longitude in degrees (-180 to 180). Requires latitude.",
      }),
    ),
    timeoutMs: TimeoutMsParameter,
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const location = validateMapsLocation(params);
    const timeoutMs = validateTimeoutMs(params.timeoutMs);
    return withStatus(ctx, "maps", () =>
      generateGrounded(
        {
          contents: params.query,
          tools: [{ googleMaps: {} }],
          ...(location
            ? { toolConfig: { retrievalConfig: { latLng: location } } }
            : {}),
          timeoutMs,
        },
        ctx,
        signal,
      ),
    );
  },
});

export const urlContextTool = defineTool({
  name: "url_context",
  label: "Google GenAI: URL Context",
  description: `Answer a question using specific http/https URLs as context, via Gemini. ${TRUNCATION_NOTE}`,
  promptSnippet: "Ask Gemini questions grounded in specific URLs",
  promptGuidelines: [
    "Use when the user gives specific URLs and asks about their contents; for open-ended web questions use google_search instead.",
    AUTH_GUIDELINE,
  ],
  parameters: Type.Object({
    prompt: Type.String({
      description: "Question or instruction about the provided URLs.",
    }),
    urls: Type.Array(
      Type.String({ description: "HTTP or HTTPS URL to use as context." }),
      {
        description: `${MAX_URLS} URLs max.`,
        minItems: 1,
        maxItems: MAX_URLS,
      },
    ),
    timeoutMs: TimeoutMsParameter,
  }),
  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const urls = validateUrls(params.urls);
    const timeoutMs = validateTimeoutMs(params.timeoutMs);
    return withStatus(ctx, "url", () =>
      generateGrounded(
        {
          contents: `${params.prompt}\n\nURLs:\n${urls.join("\n")}`,
          tools: [{ urlContext: {} }],
          timeoutMs,
        },
        ctx,
        signal,
      ),
    );
  },
});

/**
 * deep_research needs `pi.sendMessage` to report a completed background run
 * back into the conversation, which tool `execute()` does not receive
 * directly — so the tool is built by a factory closing over `pi`.
 */
export function createDeepResearchTool(pi: ExtensionAPI) {
  return defineTool({
    name: "deep_research",
    label: "Google GenAI: Deep Research",
    description:
      "Start (or check on) Gemini's agentic Deep Research on a topic (Vertex AI backend only). " +
      "Research runs in the background for minutes to tens of minutes; this call returns " +
      "immediately with an interactionId, and a message announces the result when it finishes.",
    promptSnippet:
      "Run deep, multi-step web research through Gemini's Deep Research agent",
    promptGuidelines: [
      "Use for open-ended research that needs multi-step investigation and synthesis, not a quick fact lookup (use google_search instead).",
      'Start a new run with "query"; it returns immediately, and a message will announce the result once it finishes — do not poll by calling this again.',
      "Use interactionId only to check the current status of a run on demand; do not start a new run for a topic you are already waiting on.",
      AUTH_GUIDELINE,
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Research topic or question. Omit when checking via interactionId.",
        }),
      ),
      interactionId: Type.Optional(
        Type.String({
          description:
            "Check the status of a previously started run instead of starting a new one.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const { query, interactionId } = validateDeepResearchParams(params);
      return withStatus(ctx, "deep research", async () => {
        const result = interactionId
          ? await checkDeepResearch(interactionId, ctx)
          : await startDeepResearch(query as string, ctx, pi);
        return formatDeepResearchResult(result, !interactionId);
      });
    },
  });
}

export function validateDeepResearchParams(params: {
  query?: unknown;
  interactionId?: unknown;
}): { query?: string; interactionId?: string } {
  const hasQuery =
    typeof params.query === "string" && params.query.trim() !== "";
  const hasInteractionId =
    typeof params.interactionId === "string" &&
    params.interactionId.trim() !== "";
  if (!hasQuery && !hasInteractionId) {
    throw new Error(
      "Provide either query (to start) or interactionId (to resume).",
    );
  }
  if (hasQuery && hasInteractionId) {
    throw new Error("Provide only one of query or interactionId, not both.");
  }
  return {
    query: hasQuery ? (params.query as string).trim() : undefined,
    interactionId: hasInteractionId
      ? (params.interactionId as string).trim()
      : undefined,
  };
}

export function formatDeepResearchResult(
  result: DeepResearchResult,
  started: boolean,
) {
  const lines = [
    `status: ${result.status}`,
    `interactionId: ${result.interactionId}`,
  ];
  if (result.done) {
    lines.push("", result.answer ?? "No answer text was produced.");
  } else if (started) {
    lines.push(
      "Started in the background. A message will announce the result when it finishes; " +
        `do not call deep_research again to poll (checking via interactionId "${result.interactionId}" is fine if needed).`,
    );
  } else {
    lines.push(`steps so far: ${result.stepCount}`, "Still running.");
  }
  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      interactionId: result.interactionId,
      status: result.status,
      done: result.done,
    },
  };
}

async function withStatus<T>(
  ctx: ExtensionContext,
  status: string,
  fn: () => Promise<T>,
): Promise<T> {
  ctx.ui.setStatus(STATUS_KEY, status);
  try {
    return await fn();
  } finally {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  }
}
