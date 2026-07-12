import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveAuth } from "./config.ts";
import { clientFor } from "./client.ts";

export const DEEP_RESEARCH_AGENT = "deep-research-preview-04-2026";
export const POLL_INTERVAL_MS = 15_000;
export const MESSAGE_CUSTOM_TYPE = "google-genai-deep-research";

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

interface InteractionLike {
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

function watchInBackground(
  interactionId: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
) {
  const poll = async () => {
    let interaction: InteractionLike;
    try {
      const client = await deepResearchClient(ctx);
      interaction = (await client.interactions.get(
        interactionId,
      )) as InteractionLike;
    } catch {
      setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }
    if (!TERMINAL_STATUSES.has(interaction.status)) {
      setTimeout(poll, POLL_INTERVAL_MS);
      return;
    }
    const result = toResult(interaction);
    pi.sendMessage(
      {
        customType: MESSAGE_CUSTOM_TYPE,
        content: [
          `Deep Research ${interactionId} finished with status "${result.status}".`,
          result.answer ?? "No answer text was produced.",
        ].join("\n\n"),
        display: true,
      },
      { triggerTurn: true },
    );
  };
  setTimeout(poll, POLL_INTERVAL_MS);
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
