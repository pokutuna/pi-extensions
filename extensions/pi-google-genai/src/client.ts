import { createHash } from "node:crypto";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  GoogleGenAI,
  type ToolConfig,
  type ToolListUnion,
} from "@google/genai";
import { loadConfig, resolveAuth, type ResolvedAuth } from "./config.ts";
import { formatToolResult } from "./format.ts";

interface GroundedRequest {
  contents: string;
  tools: ToolListUnion;
  toolConfig?: ToolConfig;
  timeoutMs?: number;
  timeoutAdvice?: string;
}

/**
 * Extra head room given to the SDK's own deadline so our AbortController is
 * always the one that fires first. `httpOptions.timeout` is sent as a
 * server-side deadline, and measured against Vertex it comes back ~90ms
 * *before* a local timer set to the same value — leaving `isTimeout()` false
 * and turning what is really a timeout into a bare `HTTP 504
 * DEADLINE_EXCEEDED`. The SDK deadline stays as a backstop for a response that
 * never arrives at all.
 */
const SDK_TIMEOUT_GRACE_MS = 5_000;

let memoizedClient: { key: string; client: GoogleGenAI } | undefined;

/**
 * Identity of a resolved auth for memoization purposes. The api-key backend is
 * keyed by a digest rather than the key itself, so live key material is not
 * retained in the memo entry.
 */
export function authCacheKey(auth: ResolvedAuth): string {
  if (auth.backend === "api-key") {
    const digest = createHash("sha256").update(auth.apiKey).digest("hex");
    return `api-key\0${digest}`;
  }
  if (auth.apiKey) {
    const digest = createHash("sha256").update(auth.apiKey).digest("hex");
    return `vertex-ai-api-key\0${digest}`;
  }
  return `vertex-ai\0${auth.project}\0${auth.location}`;
}

/** Return a GoogleGenAI client memoized on the resolved auth settings. */
export function clientFor(auth: ResolvedAuth): GoogleGenAI {
  const key = authCacheKey(auth);
  if (memoizedClient?.key !== key) {
    const client =
      auth.backend === "api-key"
        ? new GoogleGenAI({ apiKey: auth.apiKey })
        : auth.apiKey
          ? new GoogleGenAI({ vertexai: true, apiKey: auth.apiKey })
          : new GoogleGenAI({
              vertexai: true,
              project: auth.project,
              location: auth.location,
            });
    memoizedClient = { key, client };
  }
  return memoizedClient.client;
}

/**
 * Run a grounded generateContent call: resolve config/auth, enforce the
 * timeout (combined with pi's cancellation signal), format the result.
 */
export async function generateGrounded(
  request: GroundedRequest,
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  const loaded = await loadConfig();
  const auth = await resolveAuth(
    loaded.config,
    process.env,
    ctx.modelRegistry,
    {
      currentProvider: ctx.model?.provider,
    },
  );
  const client = clientFor(auth);
  const model = loaded.config.model;
  const timeoutMs = request.timeoutMs ?? loaded.config.timeoutMs;
  const timeoutSignal = makeTimeoutSignal(signal, timeoutMs);
  try {
    const response = await client.models.generateContent({
      model,
      contents: request.contents,
      config: {
        tools: request.tools,
        ...(request.toolConfig ? { toolConfig: request.toolConfig } : {}),
        abortSignal: timeoutSignal.signal,
        httpOptions: { timeout: timeoutMs + SDK_TIMEOUT_GRACE_MS },
      },
    });
    return await formatToolResult(response, model);
  } catch (error) {
    if (timeoutSignal.isTimeout()) {
      throw new Error(formatTimeoutError(timeoutMs, request.timeoutAdvice));
    }
    throw toApiError(error);
  } finally {
    timeoutSignal.cleanup();
  }
}

export function formatTimeoutError(
  timeoutMs: number,
  timeoutAdvice?: string,
): string {
  return [
    `Google GenAI request timed out after ${timeoutMs}ms.`,
    "This is a timeout, not an empty or no-results response.",
    timeoutAdvice ??
      "Try narrowing the query or splitting it into smaller calls first.",
    "To allow longer calls, raise timeoutMs in google-genai.json or pass the per-call timeoutMs parameter.",
  ].join(" ");
}

/**
 * Normalize an SDK error into one message shape. Shared with deep-research so
 * every tool reports API failures the same way.
 */
export function toApiError(error: unknown): unknown {
  if (error instanceof Error) {
    const status = (error as unknown as { status?: unknown }).status;
    if (typeof status === "number") {
      // Some SDK error classes already lead with the status; don't repeat it.
      const message = error.message.replace(new RegExp(`^${status}\\s+`), "");
      return new Error(
        `Google GenAI request failed (HTTP ${status}): ${message}`,
      );
    }
  }
  return error;
}

interface TimeoutSignal {
  signal: AbortSignal;
  cleanup(): void;
  isTimeout(): boolean;
}

function makeTimeoutSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): TimeoutSignal {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener("abort", abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Timed out after ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortFromParent);
    },
    isTimeout: () => timedOut,
  };
}
