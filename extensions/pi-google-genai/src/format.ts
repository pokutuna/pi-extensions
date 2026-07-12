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
  const text = joinBlocks([outputText, formatSourcesSection(sources)]);
  const truncation = truncateHead(text, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const details: GenaiDetails = {
    model,
    sources,
    truncated: truncation.truncated,
  };

  if (!truncation.truncated) {
    return { content: [{ type: "text", text: truncation.content }], details };
  }

  const fullResponsePath = await writeRawResponse(response);
  details.fullResponsePath = fullResponsePath;
  details.truncation = {
    truncatedBy: truncation.truncatedBy,
    totalLines: truncation.totalLines,
    totalBytes: truncation.totalBytes,
    outputLines: truncation.outputLines,
    outputBytes: truncation.outputBytes,
  };
  const footer =
    `[Output truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines ` +
    `(${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). ` +
    `Full response saved to: ${fullResponsePath}]`;
  const suffix = joinBlocks([formatSourcesSection(sources), footer]);
  const truncatedOutput = truncateHead(outputText, {
    maxLines: Math.max(0, DEFAULT_MAX_LINES - countLines(suffix) - 1),
    maxBytes: Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(suffix, "utf8") - 2),
  });
  const content = joinBlocks([truncatedOutput.content, suffix]);
  return { content: [{ type: "text", text: content }], details };
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
    (source, index) => truncateLine(`${index + 1}. ${formatSource(source)}`).text,
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
    (existing) => `${existing.type}\0${existing.uri ?? ""}\0${existing.title ?? ""}` === key,
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
