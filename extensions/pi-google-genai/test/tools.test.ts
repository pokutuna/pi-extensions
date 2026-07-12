import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_TIMEOUT_MS } from "../src/config.ts";
import {
  formatDeepResearchResult,
  validateDeepResearchParams,
  validateMapsLocation,
  validateSearchTypes,
  validateTimeoutMs,
  validateUrls,
} from "../src/tools.ts";

test("validateSearchTypes: undefined passes through", () => {
  assert.equal(validateSearchTypes(undefined), undefined);
});

test("validateSearchTypes: accepts web_search and image_search", () => {
  assert.deepEqual(validateSearchTypes(["web_search"]), ["web_search"]);
  assert.deepEqual(validateSearchTypes(["image_search"]), ["image_search"]);
  assert.deepEqual(validateSearchTypes(["web_search", "image_search"]), [
    "web_search",
    "image_search",
  ]);
});

test("validateSearchTypes: dedupes values", () => {
  assert.deepEqual(validateSearchTypes(["web_search", "web_search"]), [
    "web_search",
  ]);
});

test("validateSearchTypes: rejects non-array or unknown values", () => {
  assert.throws(() => validateSearchTypes("web_search"), /array/);
  assert.throws(
    () => validateSearchTypes(["maps_search"]),
    /searchTypes supports only/,
  );
});

test("validateTimeoutMs: undefined passes through", () => {
  assert.equal(validateTimeoutMs(undefined), undefined);
});

test("validateTimeoutMs: accepts valid integers", () => {
  assert.equal(validateTimeoutMs(1), 1);
  assert.equal(validateTimeoutMs(60_000), 60_000);
  assert.equal(validateTimeoutMs(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
});

test("validateTimeoutMs: rejects out-of-range and non-integer values", () => {
  assert.throws(() => validateTimeoutMs(0), /timeoutMs/);
  assert.throws(() => validateTimeoutMs(-5), /timeoutMs/);
  assert.throws(() => validateTimeoutMs(1.5), /timeoutMs/);
  assert.throws(() => validateTimeoutMs(MAX_TIMEOUT_MS + 1), /timeoutMs/);
  assert.throws(() => validateTimeoutMs("100"), /timeoutMs/);
});

test("validateMapsLocation: both omitted returns undefined", () => {
  assert.equal(validateMapsLocation({}), undefined);
});

test("validateMapsLocation: accepts a valid pair", () => {
  assert.deepEqual(
    validateMapsLocation({ latitude: 35.68, longitude: 139.76 }),
    {
      latitude: 35.68,
      longitude: 139.76,
    },
  );
});

test("validateMapsLocation: rejects unpaired coordinates", () => {
  assert.throws(() => validateMapsLocation({ latitude: 35 }), /together/);
  assert.throws(() => validateMapsLocation({ longitude: 139 }), /together/);
});

test("validateMapsLocation: rejects out-of-range coordinates", () => {
  assert.throws(
    () => validateMapsLocation({ latitude: 91, longitude: 0 }),
    /latitude/,
  );
  assert.throws(
    () => validateMapsLocation({ latitude: -91, longitude: 0 }),
    /latitude/,
  );
  assert.throws(
    () => validateMapsLocation({ latitude: 0, longitude: 181 }),
    /longitude/,
  );
  assert.throws(
    () => validateMapsLocation({ latitude: 0, longitude: -181 }),
    /longitude/,
  );
});

test("validateMapsLocation: rejects non-finite numbers", () => {
  assert.throws(
    () => validateMapsLocation({ latitude: Number.NaN, longitude: 0 }),
    /latitude/,
  );
  assert.throws(
    () =>
      validateMapsLocation({
        latitude: 0,
        longitude: Number.POSITIVE_INFINITY,
      }),
    /longitude/,
  );
});

test("validateUrls: accepts and trims http/https URLs", () => {
  assert.deepEqual(
    validateUrls([" https://example.com/a ", "http://example.com/b"]),
    ["https://example.com/a", "http://example.com/b"],
  );
});

test("validateUrls: rejects empty or non-array input", () => {
  assert.throws(() => validateUrls([]), /at least one/);
  assert.throws(() => validateUrls("https://example.com"), /at least one/);
});

test("validateUrls: rejects non-http schemes", () => {
  assert.throws(() => validateUrls(["ftp://example.com"]), /http/);
  assert.throws(() => validateUrls(["file:///etc/passwd"]), /http/);
});

test("validateUrls: rejects malformed URLs", () => {
  assert.throws(() => validateUrls(["not a url"]), /Invalid URL/);
  assert.throws(() => validateUrls([""]), /non-empty/);
  assert.throws(() => validateUrls([42]), /non-empty/);
});

test("validateUrls: rejects more than 20 URLs", () => {
  const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`);
  assert.throws(() => validateUrls(urls), /at most 20/);
});

test("validateDeepResearchParams: accepts query only", () => {
  assert.deepEqual(validateDeepResearchParams({ query: " topic " }), {
    query: "topic",
    interactionId: undefined,
  });
});

test("validateDeepResearchParams: accepts interactionId only", () => {
  assert.deepEqual(validateDeepResearchParams({ interactionId: " abc " }), {
    query: undefined,
    interactionId: "abc",
  });
});

test("validateDeepResearchParams: rejects neither provided", () => {
  assert.throws(() => validateDeepResearchParams({}), /Provide either/);
  assert.throws(
    () => validateDeepResearchParams({ query: "  " }),
    /Provide either/,
  );
});

test("validateDeepResearchParams: rejects both provided", () => {
  assert.throws(
    () => validateDeepResearchParams({ query: "topic", interactionId: "abc" }),
    /only one/,
  );
});

test("formatDeepResearchResult: done with answer", () => {
  const result = formatDeepResearchResult(
    {
      interactionId: "abc",
      status: "completed",
      stepCount: 5,
      answer: "The answer.",
      done: true,
    },
    true,
  );
  const text = result.content[0].text;
  assert.match(text, /status: completed/);
  assert.match(text, /The answer\./);
  assert.equal(result.details.done, true);
});

test("formatDeepResearchResult: just started reports background run", () => {
  const result = formatDeepResearchResult(
    {
      interactionId: "abc",
      status: "in_progress",
      stepCount: 0,
      done: false,
    },
    true,
  );
  const text = result.content[0].text;
  assert.match(text, /Started in the background/);
  assert.equal(result.details.done, false);
});

test("formatDeepResearchResult: checked while still running", () => {
  const result = formatDeepResearchResult(
    {
      interactionId: "abc",
      status: "in_progress",
      stepCount: 3,
      done: false,
    },
    false,
  );
  const text = result.content[0].text;
  assert.match(text, /Still running/);
  assert.equal(result.details.done, false);
});
