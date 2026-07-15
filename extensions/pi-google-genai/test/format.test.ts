import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, test } from "node:test";
import {
  cleanupRawResponseDirectory,
  extractSources,
  formatToolResult,
  type ResponseLike,
} from "../src/format.ts";

after(async () => {
  await cleanupRawResponseDirectory();
});

test("extractSources: web grounding chunks", () => {
  const response: ResponseLike = {
    text: "answer",
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: [
            { web: { title: "Example", uri: "https://example.com" } },
            { web: { title: "Other", uri: "https://other.example" } },
          ],
        },
      },
    ],
  };
  const sources = extractSources(response);
  assert.deepEqual(sources, [
    { type: "web", title: "Example", uri: "https://example.com" },
    { type: "web", title: "Other", uri: "https://other.example" },
  ]);
});

test("extractSources: maps chunks include placeId", () => {
  const response: ResponseLike = {
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: [
            {
              maps: {
                title: "Tokyo Tower",
                uri: "https://maps.google.com/?cid=1",
                placeId: "places/abc123",
              },
            },
          ],
        },
      },
    ],
  };
  assert.deepEqual(extractSources(response), [
    {
      type: "maps",
      title: "Tokyo Tower",
      uri: "https://maps.google.com/?cid=1",
      placeId: "places/abc123",
    },
  ]);
});

test("extractSources: url context metadata with status", () => {
  const response: ResponseLike = {
    candidates: [
      {
        urlContextMetadata: {
          urlMetadata: [
            {
              retrievedUrl: "https://example.com/doc",
              urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
            },
          ],
        },
      },
    ],
  };
  assert.deepEqual(extractSources(response), [
    {
      type: "url_context",
      uri: "https://example.com/doc",
      status: "URL_RETRIEVAL_STATUS_SUCCESS",
    },
  ]);
});

test("extractSources: deduplicates and skips empty chunks", () => {
  const response: ResponseLike = {
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: [
            { web: { title: "Example", uri: "https://example.com" } },
            { web: { title: "Example", uri: "https://example.com" } },
            { web: {} },
            {},
          ],
        },
      },
    ],
  };
  assert.equal(extractSources(response).length, 1);
});

test("extractSources: empty response yields no sources", () => {
  assert.deepEqual(extractSources({}), []);
  assert.deepEqual(extractSources({ candidates: [] }), []);
});

test("formatToolResult: answer text plus sources section", async () => {
  const response: ResponseLike = {
    text: "The answer.",
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: [
            { web: { title: "Example", uri: "https://example.com" } },
          ],
        },
      },
    ],
  };
  const result = await formatToolResult(response, "gemini-test");
  const text = result.content[0].text;
  assert.match(text, /^The answer\./);
  assert.match(text, /Sources:\n1\. Example — https:\/\/example\.com/);
  assert.equal(result.details.model, "gemini-test");
  assert.equal(result.details.truncated, false);
  assert.equal(result.details.sources.length, 1);
});

test("formatToolResult: empty text yields placeholder", async () => {
  const result = await formatToolResult({}, "gemini-test");
  assert.match(result.content[0].text, /No response received\./);
});

test("formatToolResult: caps the sources list", async () => {
  const chunks = Array.from({ length: 15 }, (_, i) => ({
    web: { title: `Source ${i}`, uri: `https://example.com/${i}` },
  }));
  const response: ResponseLike = {
    text: "answer",
    candidates: [{ groundingMetadata: { groundingChunks: chunks } }],
  };
  const result = await formatToolResult(response, "gemini-test");
  const text = result.content[0].text;
  assert.match(text, /10\. Source 9/);
  assert.doesNotMatch(text, /11\. Source 10/);
  assert.match(text, /and 5 more/);
  assert.equal(result.details.sources.length, 15);
});

test("formatToolResult: truncates long output and saves the raw response", async () => {
  const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  const response: ResponseLike = {
    text: longText,
    candidates: [
      {
        groundingMetadata: {
          groundingChunks: [
            { web: { title: "Example", uri: "https://example.com" } },
          ],
        },
      },
    ],
  };
  const result = await formatToolResult(response, "gemini-test");
  const text = result.content[0].text;
  assert.equal(result.details.truncated, true);
  assert.match(text, /\[Output truncated: showing \d+ of \d+ lines/);
  assert.match(text, /Sources:/);
  assert.ok(result.details.fullResponsePath, "fullResponsePath should be set");
  assert.match(text, /Full response saved to: /);
  const saved = JSON.parse(
    await readFile(result.details.fullResponsePath as string, "utf8"),
  );
  assert.equal(saved.text, longText);
});

test("formatToolResult: truncation footer counts describe the emitted answer", async () => {
  const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  const result = await formatToolResult({ text: longText }, "gemini-test");
  const text = result.content[0].text;

  const match = text.match(/\[Output truncated: showing (\d+) of (\d+) lines/);
  assert.ok(match, "footer should report line counts");
  const shown = Number(match[1]);
  const total = Number(match[2]);
  assert.equal(total, 5000);

  // The answer body is everything before the footer; its length must match
  // what the footer claims, rather than the pre-suffix budget's numbers.
  const body = text.slice(0, text.indexOf("[Output truncated:")).trimEnd();
  assert.equal(body.split("\n").length, shown);
  assert.equal(result.details.truncation?.outputLines, shown);
  assert.ok(shown < total, "should have actually dropped lines");
});

test("formatToolResult: keeps answer text even when sources crowd the budget", async () => {
  // 15 sources with long URLs, plus a footer, would leave a naive budget
  // calculation at or below zero lines for the answer itself.
  const chunks = Array.from({ length: 15 }, (_, i) => ({
    web: {
      title: `Very long source title number ${i} `.repeat(8),
      uri: `https://example.com/${"segment/".repeat(40)}${i}`,
    },
  }));
  const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  const result = await formatToolResult(
    {
      text: longText,
      candidates: [{ groundingMetadata: { groundingChunks: chunks } }],
    },
    "gemini-test",
  );
  const text = result.content[0].text;
  assert.equal(result.details.truncated, true);
  assert.match(text, /^line 0/, "answer text must survive");
  assert.match(text, /Sources:/);
  assert.match(text, /\[Output truncated:/);
});

test("cleanupRawResponseDirectory: removes saved responses and is idempotent", async () => {
  const longText = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join(
    "\n",
  );
  const result = await formatToolResult({ text: longText }, "gemini-test");
  const path = result.details.fullResponsePath as string;
  await cleanupRawResponseDirectory();
  await assert.rejects(() => readFile(path, "utf8"));
  await cleanupRawResponseDirectory();
});
