import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import {
  activePollCount,
  cancelBackgroundPolls,
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
