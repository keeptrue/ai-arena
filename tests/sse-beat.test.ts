import { describe, expect, test } from "bun:test";
import { readSse } from "../src/providers/sse";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe("stream liveness", () => {
  test("keep-alive comments are life, not content", async () => {
    const events: string[] = [];
    let beats = 0;
    await readSse(
      streamOf([": ping\n\n", ": ping\n\n"]),
      (data) => events.push(data),
      () => {
        beats += 1;
      },
    );
    // The gateway said nothing useful, but it did say something: the call window
    // must not read a pinging connection as a dead one.
    expect(events).toHaveLength(0);
    expect(beats).toBe(2);
  });

  test("a heartbeat and a content frame are counted separately", async () => {
    const events: string[] = [];
    let beats = 0;
    await readSse(
      streamOf([": ping\n\n", 'data: {"choices":[{"delta":{"content":"好"}}]}\n\n']),
      (data) => events.push(data),
      () => {
        beats += 1;
      },
    );
    expect(beats).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"好"');
  });

  test("a reader with no beat handler still parses exactly as before", async () => {
    const events: string[] = [];
    await readSse(streamOf(["data: one\n\n", "data: two\n\n"]), (data) => events.push(data));
    expect(events).toEqual(["one", "two"]);
  });

  test("an empty body resolves without firing anything", async () => {
    let beats = 0;
    const events: string[] = [];
    await readSse(streamOf([]), (data) => events.push(data), () => {
      beats += 1;
    });
    expect(beats).toBe(0);
    expect(events).toHaveLength(0);
  });
});
