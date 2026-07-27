import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { loadConfig, resolveAuth } from "./config.ts";
import { clientFor, toApiError } from "./client.ts";

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

/**
 * A `url_citation` annotation: one cited page, plus the byte offsets of the
 * `[cite: 4, 7, 8]` marker it belongs to. A marker carrying three numbers
 * carries three annotations over the same span, in the numbers' order — that
 * pairing is what ties each `[cite: N]` to a page.
 *
 * The offsets are bytes into the whole report, which is not always the part
 * they hang off: see `assembleReport`.
 */
interface AnnotationLike {
  type?: string;
  url?: string;
  title?: string;
  start_index?: number;
  end_index?: number;
}

interface PartLike {
  type?: string;
  text?: string;
  annotations?: AnnotationLike[];
}

interface StepLike {
  type?: string;
  content?: PartLike[];
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
  const interaction = await normalizeErrors(
    () =>
      client.interactions.create({
        agent: DEEP_RESEARCH_AGENT,
        input,
        background: true,
      }) as Promise<InteractionLike>,
  );
  watchInBackground(interaction.id, ctx, pi);
  return toResult(interaction);
}

/** Check the current status of a previously started interaction, without waiting. */
export async function checkDeepResearch(
  interactionId: string,
  ctx: ExtensionContext,
): Promise<DeepResearchResult> {
  const client = await deepResearchClient(ctx);
  const interaction = await normalizeErrors(
    () => client.interactions.get(interactionId) as Promise<InteractionLike>,
  );
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
  return await normalizeErrors(
    () => client.interactions.get(interactionId) as Promise<InteractionLike>,
  );
}

/**
 * Put SDK failures into the same shape the grounded tools report, so a failed
 * interaction reads like `Google GenAI request failed (HTTP 400): ...` rather
 * than whatever error class the SDK happened to throw.
 */
async function normalizeErrors<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw toApiError(error);
  }
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
  const auth = await resolveAuth(
    loaded.config,
    process.env,
    ctx.modelRegistry,
    {
      currentProvider: ctx.model?.provider,
    },
  );
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
  const report = assembleReport(steps);
  if (!report) return undefined;
  return [report.text.trim(), citationSection(report.text, report.annotations)]
    .filter(Boolean)
    .join("\n\n");
}

/** A text part of the output, or the whole report once assembled. */
interface ReportText {
  text: string;
  annotations: AnnotationLike[];
}

/**
 * Reassemble the final report from the trailing `model_output` text parts.
 *
 * A report that embeds a chart arrives split across steps — text, image, text
 * — so its last text part is only the tail. The citation offsets say where the
 * report starts: parts are prepended, joined with no separator because that is
 * what the offsets are measured against, until the annotated range fits.
 */
function assembleReport(steps: StepLike[]): ReportText | undefined {
  const parts: ReportText[] = [];
  for (const step of steps) {
    if (step?.type !== "model_output") continue;
    for (const part of step.content ?? [])
      if (part?.type === "text" && part.text)
        parts.push({ text: part.text, annotations: part.annotations ?? [] });
  }

  let index = parts.length - 1;
  if (index < 0) return undefined;
  const { annotations } = parts[index];
  const end = Math.max(0, ...annotations.map((a) => a.end_index ?? 0));

  let text = parts[index].text;
  while (Buffer.byteLength(text, "utf8") < end && index > 0) {
    index--;
    text = parts[index].text + text;
  }
  return text.trim() ? { text, annotations } : undefined;
}

/**
 * The pages the report cites, listed after it. Every citation is listed:
 * unlike the grounded tools' capped `Sources:` section, a research report's
 * value is largely in its sources.
 *
 * Entries are numbered with the agent's own `[cite: N]` numbers whenever those
 * can be resolved, so a marker in the prose points at a line here. The
 * resolution verifies itself — every span has to land exactly on a marker
 * whose numbers match its annotations — and falls back to listing the pages
 * under this section's own numbering if anything disagrees.
 */
export function citationSection(
  report: string,
  annotations: AnnotationLike[],
): string {
  const cited = annotations.filter(
    (annotation): annotation is Citation =>
      annotation.type === "url_citation" && !!annotation.url,
  );
  const lines = numberedSources(report, cited) ?? listedSources(cited);
  if (lines.length === 0) return "";
  // A bullet list, because bare lines render as one run-together paragraph.
  // Not an ordered list: Markdown would renumber it, and these numbers have to
  // stay as the agent wrote them.
  return ["Sources:", "", ...lines.map((line) => `- ${line}`)].join("\n");
}

const CITE_MARKER = /^\[cite:[\s\d,]+\]$/;

/** A `url_citation` annotation that actually carries a URL. */
interface Citation extends AnnotationLike {
  url: string;
}

/**
 * `[N] title — url` under the agent's own numbering, or `undefined` if the
 * offsets do not resolve — in which case the caller lists the pages instead.
 */
function numberedSources(
  report: string,
  cited: Citation[],
): string[] | undefined {
  const buffer = Buffer.from(report, "utf8");
  const spans = new Map<string, Citation[]>();
  for (const annotation of cited) {
    const { start_index: start, end_index: end } = annotation;
    // A few annotations arrive with no offsets — extras alongside the located
    // ones, not citations of their own. Skipping them leaves the markers they
    // would have belonged to resolvable; bailing on them would not.
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (start < 0 || end > buffer.length) continue;
    const key = `${start}:${end}`;
    spans.set(key, [...(spans.get(key) ?? []), annotation]);
  }
  if (spans.size === 0) return undefined;

  const byNumber = new Map<number, Citation>();
  for (const [key, group] of spans) {
    const [start, end] = key.split(":").map(Number);
    const marker = buffer.subarray(start, end).toString("utf8");
    if (!CITE_MARKER.test(marker)) return undefined;
    const numbers = (marker.match(/\d+/g) ?? []).map(Number);
    if (numbers.length !== group.length) return undefined;
    numbers.forEach((number, i) => {
      if (!byNumber.has(number)) byNumber.set(number, group[i]);
    });
  }
  return [...byNumber]
    .sort(([a], [b]) => a - b)
    .map(([number, annotation]) => `[${number}] ${sourceLabel(annotation)}`);
}

/**
 * Cited pages in the order they were first annotated, deduplicated by title
 * rather than URL: a page is annotated once per citation, each time with a
 * different single-use redirect URL.
 */
function listedSources(cited: Citation[]): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const citation of cited) {
    const key = citation.title ?? citation.url;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`[${lines.length + 1}] ${sourceLabel(citation)}`);
  }
  return lines;
}

/** A page as `title — url`; the title itself carries its domain on line 2. */
function sourceLabel(citation: Citation): string {
  const title = citation.title?.split("\n").join(" — ");
  return `${title ? `${title} — ` : ""}${citation.url}`;
}
