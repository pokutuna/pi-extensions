import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveAuth } from "./config.ts";
import { clientFor } from "./client.ts";

export const DEEP_RESEARCH_AGENT = "deep-research-preview-04-2026";
export const POLL_INTERVAL_MS = 15_000;
export const MESSAGE_CUSTOM_TYPE = "google-genai-deep-research";

/**
 * Bounds on the background poll. Deep Research runs for minutes to tens of
 * minutes, so these are generous — they exist to stop a poll that can never
 * succeed (deleted interaction, revoked credentials) from looping forever,
 * not to cap normal runs.
 */
export const MAX_POLL_DURATION_MS = 2 * 60 * 60 * 1000;
export const MAX_CONSECUTIVE_ERRORS = 10;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "incomplete",
  "budget_exceeded",
]);

interface StepLike {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
}

export interface InteractionLike {
  id: string;
  status: string;
  steps?: StepLike[];
}

export interface DeepResearchResult {
  interactionId: string;
  status: string;
  stepCount: number;
  answer?: string;
  done: boolean;
}

/**
 * Start a Deep Research interaction (Vertex AI backend only) and immediately
 * return a handle. Research runs for minutes to tens of minutes, far past any
 * single tool call's timeout, so this does not wait for completion: it kicks
 * off a detached background poll that reports back via `pi.sendMessage` once
 * the interaction reaches a terminal status.
 */
export async function startDeepResearch(
  input: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<DeepResearchResult> {
  const client = await deepResearchClient(ctx);
  const interaction = (await client.interactions.create({
    agent: DEEP_RESEARCH_AGENT,
    input,
    background: true,
  })) as InteractionLike;
  watchInBackground(interaction.id, ctx, pi);
  return toResult(interaction);
}

/** Check the current status of a previously started interaction, without waiting. */
export async function checkDeepResearch(
  interactionId: string,
  ctx: ExtensionContext,
): Promise<DeepResearchResult> {
  const client = await deepResearchClient(ctx);
  const interaction = (await client.interactions.get(
    interactionId,
  )) as InteractionLike;
  return toResult(interaction);
}

/** Timers for in-flight background polls, so shutdown can cancel them. */
const activePolls = new Map<string, NodeJS.Timeout>();

/** Stop every in-flight background poll. Safe to call multiple times. */
export function cancelBackgroundPolls(): void {
  for (const timer of activePolls.values()) clearTimeout(timer);
  activePolls.clear();
}

/** Number of polls currently scheduled. Exposed for tests. */
export function activePollCount(): number {
  return activePolls.size;
}

function schedule(interactionId: string, poll: () => void) {
  activePolls.set(interactionId, setTimeout(poll, POLL_INTERVAL_MS));
}

function watchInBackground(
  interactionId: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) {
  watchInteraction(interactionId, pi, () =>
    fetchInteraction(interactionId, ctx),
  );
}

async function fetchInteraction(
  interactionId: string,
  ctx: ExtensionContext,
): Promise<InteractionLike> {
  const client = await deepResearchClient(ctx);
  return (await client.interactions.get(interactionId)) as InteractionLike;
}

/**
 * Poll `fetch` until the interaction reaches a terminal status, then announce
 * the outcome via `pi.sendMessage`. Bounded by MAX_CONSECUTIVE_ERRORS and
 * MAX_POLL_DURATION_MS so an interaction that can never be read (deleted,
 * credentials revoked) stops being polled instead of looping forever.
 *
 * `fetch` is a parameter so tests can drive the loop without the SDK.
 */
export function watchInteraction(
  interactionId: string,
  pi: Pick<ExtensionAPI, "sendMessage">,
  fetch: () => Promise<InteractionLike>,
) {
  const deadline = Date.now() + MAX_POLL_DURATION_MS;
  let consecutiveErrors = 0;

  const announce = (content: string) => {
    activePolls.delete(interactionId);
    pi.sendMessage(
      { customType: MESSAGE_CUSTOM_TYPE, content, display: true },
      { triggerTurn: true },
    );
  };

  const poll = async () => {
    activePolls.delete(interactionId);
    let interaction: InteractionLike;
    try {
      interaction = await fetch();
      consecutiveErrors = 0;
    } catch (error) {
      consecutiveErrors++;
      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        announce(
          `Deep Research ${interactionId} could not be checked: ${MAX_CONSECUTIVE_ERRORS} consecutive ` +
            `errors, last one "${errorMessage(error)}". Gave up watching it; ` +
            `check it with deep_research interactionId "${interactionId}".`,
        );
        return;
      }
      if (Date.now() >= deadline) {
        announce(timeoutNotice(interactionId));
        return;
      }
      schedule(interactionId, poll);
      return;
    }

    if (!TERMINAL_STATUSES.has(interaction.status)) {
      if (Date.now() >= deadline) {
        announce(timeoutNotice(interactionId));
        return;
      }
      schedule(interactionId, poll);
      return;
    }

    const result = toResult(interaction);
    announce(
      [
        `Deep Research ${interactionId} finished with status "${result.status}".`,
        result.answer ?? "No answer text was produced.",
      ].join("\n\n"),
    );
  };

  schedule(interactionId, poll);
}

function timeoutNotice(interactionId: string): string {
  const hours = Math.round(MAX_POLL_DURATION_MS / 3_600_000);
  return (
    `Deep Research ${interactionId} did not finish within ${hours}h; stopped watching it. ` +
    `It may still be running on the server — check it with deep_research interactionId "${interactionId}".`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function deepResearchClient(ctx: ExtensionContext) {
  const loaded = await loadConfig();
  const auth = await resolveAuth(loaded.config, process.env, ctx.modelRegistry);
  if (auth.backend !== "vertex-ai") {
    throw new Error(
      "deep_research requires the vertex-ai auth backend. " +
        'Set "auth": "vertex-ai" in google-genai.json or GOOGLE_GENAI_USE_VERTEXAI=1.',
    );
  }
  return clientFor(auth);
}

function toResult(interaction: InteractionLike): DeepResearchResult {
  const steps = interaction.steps ?? [];
  const done = TERMINAL_STATUSES.has(interaction.status);
  return {
    interactionId: interaction.id,
    status: interaction.status,
    stepCount: steps.length,
    answer: done ? extractAnswer(steps) : undefined,
    done,
  };
}

function extractAnswer(steps: StepLike[]): string | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const step = steps[i];
    if (step?.type !== "model_output") continue;
    const text = (step.content ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}
