import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  activePollCount,
  cancelBackgroundPolls,
  citationSection,
  MAX_CONSECUTIVE_ERRORS,
  MAX_POLL_DURATION_MS,
  POLL_INTERVAL_MS,
  watchInteraction,
  type InteractionLike,
} from "../src/deep-research.ts";

interface SentMessage {
  content: string;
}

function fakePi() {
  const sent: SentMessage[] = [];
  return {
    sent,
    pi: {
      sendMessage: (message: { content: string }) => {
        sent.push({ content: message.content });
      },
    } as never,
  };
}

/**
 * Advance fake time in POLL_INTERVAL_MS steps, yielding to the microtask queue
 * between ticks so each poll's awaits settle before the next timer fires.
 */
async function tick(times: number) {
  for (let i = 0; i < times; i++) {
    mock.timers.tick(POLL_INTERVAL_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

afterEach(() => {
  cancelBackgroundPolls();
  mock.timers.reset();
});

test("watchInteraction: announces once the interaction completes", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { sent, pi } = fakePi();
  let calls = 0;
  const fetch = async (): Promise<InteractionLike> => {
    calls++;
    return calls < 3
      ? { id: "i-1", status: "in_progress" }
      : {
          id: "i-1",
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [{ type: "text", text: "done." }],
            },
          ],
        };
  };

  watchInteraction("i-1", pi, fetch);
  await tick(3);

  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /finished with status "completed"/);
  assert.match(sent[0].content, /done\./);
  assert.equal(activePollCount(), 0, "poll should not be rescheduled");
});

test("watchInteraction: gives up after consecutive errors instead of looping forever", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { sent, pi } = fakePi();
  let calls = 0;
  const fetch = async (): Promise<InteractionLike> => {
    calls++;
    throw new Error("404 not found");
  };

  watchInteraction("i-2", pi, fetch);
  await tick(MAX_CONSECUTIVE_ERRORS + 5);

  assert.equal(
    calls,
    MAX_CONSECUTIVE_ERRORS,
    "should stop fetching after the cap",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /could not be checked/);
  assert.match(sent[0].content, /404 not found/);
  assert.equal(activePollCount(), 0, "poll must not stay scheduled");
});

test("watchInteraction: a transient error does not count toward the cap", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { sent, pi } = fakePi();
  let calls = 0;
  const fetch = async (): Promise<InteractionLike> => {
    calls++;
    if (calls === 1) throw new Error("transient");
    if (calls === 2) return { id: "i-3", status: "in_progress" };
    throw new Error("transient again");
  };

  watchInteraction("i-3", pi, fetch);
  // One failure, one success (resets the counter), then failures up to the cap.
  await tick(MAX_CONSECUTIVE_ERRORS + 3);

  assert.equal(
    calls,
    MAX_CONSECUTIVE_ERRORS + 2,
    "counter should reset after the successful poll",
  );
  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /could not be checked/);
});

test("watchInteraction: stops watching at the duration deadline", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { sent, pi } = fakePi();
  const fetch = async (): Promise<InteractionLike> => ({
    id: "i-4",
    status: "in_progress",
  });

  watchInteraction("i-4", pi, fetch);
  await tick(MAX_POLL_DURATION_MS / POLL_INTERVAL_MS + 2);

  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /did not finish within/);
  assert.match(sent[0].content, /i-4/);
  assert.equal(activePollCount(), 0);
});

test("cancelBackgroundPolls: stops in-flight polls and sends nothing", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { sent, pi } = fakePi();
  let calls = 0;
  const fetch = async (): Promise<InteractionLike> => {
    calls++;
    return { id: "i-5", status: "in_progress" };
  };

  watchInteraction("i-5", pi, fetch);
  await tick(2);
  assert.ok(calls > 0, "should have polled at least once");
  assert.equal(activePollCount(), 1, "a poll should be scheduled");

  cancelBackgroundPolls();
  assert.equal(activePollCount(), 0);

  const before = calls;
  await tick(5);
  assert.equal(calls, before, "no further fetches after cancel");
  assert.equal(sent.length, 0);
});

/**
 * Annotations as the API returns them: one per citation, all the ones a single
 * `[cite: ...]` marker carries sharing that marker's byte offsets, in the same
 * order as the numbers inside it.
 */
function cite(
  report: string,
  marker: string,
  sources: { url: string; title?: string }[],
) {
  const start = Buffer.byteLength(report.slice(0, report.indexOf(marker)));
  return sources.map((source) => ({
    type: "url_citation",
    start_index: start,
    end_index: start + Buffer.byteLength(marker),
    ...source,
  }));
}

test("citationSection: numbers entries with the agent's own [cite: N] numbers", () => {
  const report = "Node 24 ships V8 13.6 [cite: 3, 1]. It is LTS [cite: 2].";
  const section = citationSection(report, [
    ...cite(report, "[cite: 3, 1]", [
      { url: "https://redirect/three", title: "A blog post" },
      { url: "https://redirect/one", title: "Release notes" },
    ]),
    ...cite(report, "[cite: 2]", [
      { url: "https://redirect/two", title: "An announcement" },
    ]),
  ]);

  assert.equal(
    section,
    [
      "Sources:",
      "",
      "- [1] Release notes — https://redirect/one",
      "- [2] An announcement — https://redirect/two",
      "- [3] A blog post — https://redirect/three",
    ].join("\n"),
  );
});

test("citationSection: an annotation with no offsets does not sink the rest", () => {
  const report = "An answer [cite: 1].";
  const section = citationSection(report, [
    ...cite(report, "[cite: 1]", [
      { url: "https://redirect/one", title: "Release notes" },
    ]),
    { type: "url_citation", url: "https://redirect/stray", title: "A stray" },
  ]);

  assert.equal(
    section,
    "Sources:\n\n- [1] Release notes — https://redirect/one",
  );
});

test("citationSection: offsets are bytes, not characters", () => {
  const report = "日本語の本文です [cite: 1].";
  const section = citationSection(report, [
    ...cite(report, "[cite: 1]", [{ url: "https://example.com/ja" }]),
  ]);

  assert.equal(section, "Sources:\n\n- [1] https://example.com/ja");
});

test("citationSection: falls back to its own numbering when offsets do not resolve", () => {
  const report = "An answer with markers [cite: 1, 2].";
  const section = citationSection(report, [
    // Offsets pointing at prose rather than at the marker: unusable.
    {
      type: "url_citation",
      url: "https://redirect/one",
      title: "Release notes",
      start_index: 0,
      end_index: 10,
    },
    {
      type: "url_citation",
      url: "https://redirect/two",
      title: "A blog post",
      start_index: 0,
      end_index: 10,
    },
    // The same page again, under a fresh single-use redirect URL.
    {
      type: "url_citation",
      url: "https://redirect/one-again",
      title: "Release notes",
      start_index: 0,
      end_index: 10,
    },
  ]);

  assert.equal(
    section,
    [
      "Sources:",
      "",
      "- [1] Release notes — https://redirect/one",
      "- [2] A blog post — https://redirect/two",
    ].join("\n"),
  );
});

test("citationSection: annotations without a usable URL are ignored", () => {
  const section = citationSection("Nothing usable [cite: 2].", [
    { type: "url_citation", url: "" },
    { type: "file_citation", url: "https://redirect/other-kind" },
  ]);

  assert.equal(section, "");
});

test("watchInteraction: the announced answer carries the source list", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { sent, pi } = fakePi();
  const text = "An answer [cite: 1].";
  const fetch = async (): Promise<InteractionLike> => ({
    id: "i-6",
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text,
            annotations: cite(text, "[cite: 1]", [
              { url: "https://example.com/source", title: "A source" },
            ]),
          },
        ],
      },
    ],
  });

  watchInteraction("i-6", pi, fetch);
  await tick(1);

  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /An answer \[cite: 1\]\./);
  assert.match(
    sent[0].content,
    /Sources:\n\n- \[1\] A source — https:\/\/example\.com\/source/,
  );
});

test("watchInteraction: a report split by an embedded chart is announced whole", async () => {
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { sent, pi } = fakePi();
  const head = "Opening paragraph.\n\n";
  const tail = "Closing paragraph [cite: 1].";
  const fetch = async (): Promise<InteractionLike> => ({
    id: "i-7",
    status: "completed",
    steps: [
      // An earlier, unrelated output: not part of the report.
      { type: "model_output", content: [{ type: "text", text: "A plan." }] },
      { type: "model_output", content: [{ type: "text", text: head }] },
      { type: "model_output", content: [{ type: "image" }] },
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: tail,
            annotations: cite(head + tail, "[cite: 1]", [
              { url: "https://example.com/chart", title: "A source" },
            ]),
          },
        ],
      },
    ],
  });

  watchInteraction("i-7", pi, fetch);
  await tick(1);

  assert.equal(sent.length, 1);
  assert.match(sent[0].content, /Opening paragraph\./, "the head was dropped");
  assert.match(sent[0].content, /Closing paragraph/);
  assert.doesNotMatch(sent[0].content, /A plan\./, "earlier output crept in");
  assert.match(
    sent[0].content,
    /Sources:\n\n- \[1\] A source — https:\/\/example\.com\/chart/,
  );
});
