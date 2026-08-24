import { describe, expect, it } from "vitest";
import { searchStream } from "../commands/search-engine/index.js";
import { createUserRegex } from "../regex/index.js";
import { decode, encode } from "./bytes.js";
import { type ByteStream, streamChunks, streamLines } from "./stream.js";

/**
 * A lazy pull-based stream that produces `total` chunks on demand and
 * records how many were pulled and whether it was cancelled — models a
 * real-fs or OPFS-backed file stream.
 */
function lazySource(total: number, makeChunk: (i: number) => string) {
  const state = { pulled: 0, cancelled: false };
  let i = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= total) {
        controller.close();
        return;
      }
      state.pulled++;
      controller.enqueue(encode(makeChunk(i++)));
    },
    cancel() {
      state.cancelled = true;
    },
  }) as ByteStream;
  return { stream, state };
}

describe("streamChunks", () => {
  it("cancels the source when the consumer exits early", async () => {
    const { stream, state } = lazySource(100, (i) => `chunk ${i}\n`);
    for await (const chunk of streamChunks(stream)) {
      if (decode(chunk).startsWith("chunk 2")) break;
    }
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(100);
  });

  it("does not cancel a fully consumed source", async () => {
    const { stream, state } = lazySource(3, (i) => `chunk ${i}\n`);
    const chunks: string[] = [];
    for await (const chunk of streamChunks(stream)) {
      chunks.push(decode(chunk));
    }
    expect(chunks).toHaveLength(3);
    expect(state.cancelled).toBe(false);
  });
});

describe("streamLines", () => {
  it("cancels the source when the consumer exits early", async () => {
    const { stream, state } = lazySource(100, (i) => `line ${i}\n`);
    let seen = 0;
    for await (const _line of streamLines(stream)) {
      if (++seen >= 5) break;
    }
    expect(state.cancelled).toBe(true);
    expect(state.pulled).toBeLessThan(100);
  });

  it("assembles a line spanning many chunks exactly once", async () => {
    // 50 chunks with no newline, then the terminator — the carry must not
    // be recopied per chunk (that was quadratic on single-line inputs).
    const { stream } = lazySource(51, (i) => (i < 50 ? `part${i};` : "\n"));
    const lines: string[] = [];
    for await (const line of streamLines(stream)) {
      lines.push(decode(line));
    }
    expect(lines).toEqual([
      Array.from({ length: 50 }, (_, i) => `part${i};`).join(""),
    ]);
  });

  it("yields chunk-boundary lines and a trailing partial line", async () => {
    const { stream } = lazySource(3, (i) => ["a\nb", "\n", "tail"][i]);
    const lines: string[] = [];
    for await (const line of streamLines(stream)) {
      lines.push(decode(line));
    }
    expect(lines).toEqual(["a", "b", "tail"]);
  });

  it("handles empty lines and CR bytes verbatim", async () => {
    const { stream } = lazySource(1, () => "a\n\nb\r\nc");
    const lines: string[] = [];
    for await (const line of streamLines(stream)) {
      lines.push(decode(line));
    }
    expect(lines).toEqual(["a", "", "b\r", "c"]);
  });
});

describe("searchStream with a lazy source", () => {
  it("stops pulling and cancels after maxCount matches", async () => {
    // Match is in chunk 10 of 1000; grep -l style search (maxCount: 1)
    // must not read the remaining ~990 chunks.
    const { stream, state } = lazySource(1000, (i) =>
      i === 10 ? "needle here\n" : `haystack line ${i}\n`,
    );
    const regex = createUserRegex("needle", "g");
    const s = searchStream(stream, regex, { maxCount: 1 });
    const chunks: string[] = [];
    for await (const chunk of streamChunks(s.output)) {
      chunks.push(decode(chunk));
    }
    expect(await s.matched).toBe(true);
    expect(chunks.join("")).toBe("needle here\n");
    expect(state.pulled).toBeLessThan(20);
    expect(state.cancelled).toBe(true);
  });
});
