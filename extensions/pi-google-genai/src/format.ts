import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateLine,
} from "@earendil-works/pi-coding-agent";

const SOURCE_LIMIT = 10;

/**
 * Floor on the answer's byte budget when sources plus footer are themselves
 * large enough to crowd out the whole budget. Without it the answer could be
 * cut to nothing while the footer still claims content was shown.
 */
const MIN_ANSWER_BYTES = 512;

export interface GenaiSource {
  type: "web" | "maps" | "url_context";
  title?: string;
  uri?: string;
  placeId?: string;
  status?: string;
}

/**
 * Structural subset of @google/genai's GenerateContentResponse that formatting
 * relies on. Kept structural so tests can pass fabricated plain objects.
 */
export interface ResponseLike {
  text?: string;
  candidates?: Array<{
    groundingMetadata?: {
      groundingChunks?: Array<{
        web?: { title?: string; uri?: string; domain?: string };
        maps?: { title?: string; uri?: string; placeId?: string };
      }>;
    };
    urlContextMetadata?: {
      urlMetadata?: Array<{
        retrievedUrl?: string;
        urlRetrievalStatus?: string;
      }>;
    };
  }>;
}

interface GenaiDetails {
  model: string;
  sources: GenaiSource[];
  truncated: boolean;
  truncation?: {
    truncatedBy: "lines" | "bytes" | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
  };
  fullResponsePath?: string;
}

interface ToolResultContent {
  content: Array<{ type: "text"; text: string }>;
  details: GenaiDetails;
}

let rawResponseDirectoryPromise: Promise<string> | undefined;

/** Format a generateContent response into a pi tool result (answer + sources, truncated). */
export async function formatToolResult(
  response: ResponseLike,
  model: string,
): Promise<ToolResultContent> {
  const outputText = (response.text ?? "").trim() || "No response received.";
  const sources = extractSources(response);
  const sourcesSection = formatSourcesSection(sources);
  const full = joinBlocks([outputText, sourcesSection]);
  const fits = truncateHead(full, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!fits.truncated) {
    return {
      content: [{ type: "text", text: fits.content }],
      details: { model, sources, truncated: false },
    };
  }

  // Over budget. The answer is the point of the result, so it gets whatever
  // room is left after the sources and the footer, which are kept intact.
  // The footer has to quote the final sizes, but those aren't known until the
  // answer is cut — so budget against a placeholder of the same shape first,
  // then re-render the footer with the real numbers.
  const fullResponsePath = await writeRawResponse(response);
  const totalLines = fits.totalLines;
  const totalBytes = fits.totalBytes;
  const renderFooter = (shownLines: number, shownBytes: number) =>
    `[Output truncated: showing ${shownLines} of ${totalLines} lines ` +
    `(${formatSize(shownBytes)} of ${formatSize(totalBytes)}). ` +
    `Full response saved to: ${fullResponsePath}]`;

  const suffixFor = (footer: string) => joinBlocks([sourcesSection, footer]);
  const budgetFor = (suffix: string) => ({
    // joinBlocks inserts a blank line between the answer and the suffix:
    // one extra line, two extra bytes.
    maxLines: Math.max(1, DEFAULT_MAX_LINES - countLines(suffix) - 1),
    maxBytes: Math.max(
      MIN_ANSWER_BYTES,
      DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8") - 2,
    ),
  });

  const provisional = suffixFor(renderFooter(totalLines, totalBytes));
  const answer = truncateHead(outputText, budgetFor(provisional));
  const suffix = suffixFor(
    renderFooter(answer.outputLines, answer.outputBytes),
  );
  const content = joinBlocks([answer.content, suffix]);

  return {
    content: [{ type: "text", text: content }],
    details: {
      model,
      sources,
      truncated: true,
      fullResponsePath,
      truncation: {
        truncatedBy: fits.truncatedBy,
        totalLines,
        totalBytes,
        outputLines: answer.outputLines,
        outputBytes: answer.outputBytes,
      },
    },
  };
}

/** Extract deduplicated sources from grounding and URL-context metadata. */
export function extractSources(response: ResponseLike): GenaiSource[] {
  const sources: GenaiSource[] = [];
  const candidate = response.candidates?.[0];
  if (!candidate) return sources;

  for (const chunk of candidate.groundingMetadata?.groundingChunks ?? []) {
    if (chunk.web && (chunk.web.uri || chunk.web.title)) {
      addSource(sources, {
        type: "web",
        title: chunk.web.title,
        uri: chunk.web.uri,
      });
    }
    if (chunk.maps && (chunk.maps.uri || chunk.maps.title)) {
      addSource(sources, {
        type: "maps",
        title: chunk.maps.title,
        uri: chunk.maps.uri,
        placeId: chunk.maps.placeId,
      });
    }
  }
  for (const metadata of candidate.urlContextMetadata?.urlMetadata ?? []) {
    if (!metadata.retrievedUrl) continue;
    addSource(sources, {
      type: "url_context",
      uri: metadata.retrievedUrl,
      status: metadata.urlRetrievalStatus,
    });
  }
  return sources;
}

export function formatSourcesSection(sources: GenaiSource[]): string {
  if (sources.length === 0) return "";
  const visible = sources.slice(0, SOURCE_LIMIT);
  const lines = visible.map(
    (source, index) =>
      truncateLine(`${index + 1}. ${formatSource(source)}`).text,
  );
  if (sources.length > SOURCE_LIMIT) {
    lines.push(`... and ${sources.length - SOURCE_LIMIT} more`);
  }
  return ["Sources:", ...lines].join("\n");
}

function formatSource(source: GenaiSource): string {
  const label = source.title ?? source.uri ?? source.type;
  const uri = source.uri && source.uri !== label ? ` — ${source.uri}` : "";
  const status = source.status ? ` (${source.status})` : "";
  return `${label}${uri}${status}`;
}

function addSource(sources: GenaiSource[], source: GenaiSource) {
  const key = `${source.type}\0${source.uri ?? ""}\0${source.title ?? ""}`;
  const exists = sources.some(
    (existing) =>
      `${existing.type}\0${existing.uri ?? ""}\0${existing.title ?? ""}` ===
      key,
  );
  if (!exists) sources.push(source);
}

function joinBlocks(blocks: string[]): string {
  return blocks.filter(Boolean).join("\n\n");
}

function countLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.length;
}

async function writeRawResponse(raw: unknown): Promise<string> {
  const directory = await rawResponseDirectory();
  const path = join(directory, `response-${Date.now()}-${randomUUID()}.json`);
  await writeFile(path, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  return path;
}

function rawResponseDirectory(): Promise<string> {
  rawResponseDirectoryPromise ??= mkdtemp(join(tmpdir(), "pi-google-genai-"))
    .then(async (directory) => {
      await chmod(directory, 0o700);
      return directory;
    })
    .catch((error) => {
      rawResponseDirectoryPromise = undefined;
      throw error;
    });
  return rawResponseDirectoryPromise;
}

/** Remove the session-scoped raw-response directory. Safe to call multiple times. */
export async function cleanupRawResponseDirectory(): Promise<void> {
  const directoryPromise = rawResponseDirectoryPromise;
  rawResponseDirectoryPromise = undefined;
  if (!directoryPromise) return;
  try {
    await rm(await directoryPromise, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup; never fail session shutdown.
  }
}
