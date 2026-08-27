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

  // A line that spans many chunks is the shape of an HTML email body, whose
  // base64 inline images are not line-broken. Joining the carried prefix onto
  // every arriving chunk re-copies it each time (quadratic); the pending tail
  // is instead held unjoined and concatenated once, so these cases pin the
  // reassembly that rewrite has to get right.
  it("reassembles one line spanning many chunks", async () => {
    const { stream } = lazySource(200, () => "x".repeat(50));
    const lines: string[] = [];
    for await (const line of streamLines(stream)) lines.push(decode(line));
    expect(lines).toEqual(["x".repeat(200 * 50)]);
  });

  it("reassembles a multi-chunk line followed by more lines", async () => {
    const chunks = ["aaa", "bbb", "ccc\nshort\n", "ddd", "eee\n"];
    const { stream } = lazySource(chunks.length, (i) => chunks[i]);
    const lines: string[] = [];
    for await (const line of streamLines(stream)) lines.push(decode(line));
    expect(lines).toEqual(["aaabbbccc", "short", "dddeee"]);
  });

  it("handles newlines landing exactly on chunk boundaries", async () => {
    const chunks = ["one\n", "two\n", "\n", "three\n"];
    const { stream } = lazySource(chunks.length, (i) => chunks[i]);
    const lines: string[] = [];
    for await (const line of streamLines(stream)) lines.push(decode(line));
    expect(lines).toEqual(["one", "two", "", "three"]);
  });

  it("yields a trailing line with no newline", async () => {
    const chunks = ["a\nb", "cd"];
    const { stream } = lazySource(chunks.length, (i) => chunks[i]);
    const lines: string[] = [];
    for await (const line of streamLines(stream)) lines.push(decode(line));
    expect(lines).toEqual(["a", "bcd"]);
  });

  it("emits nothing for an empty source", async () => {
    const { stream } = lazySource(0, () => "");
    const lines: string[] = [];
    for await (const line of streamLines(stream)) lines.push(decode(line));
    expect(lines).toEqual([]);
  });

  // Guards the complexity, not just the output: carrying the partial line as
  // unjoined pieces makes this linear, while joining the prefix onto each
  // arriving chunk copies ~9 GB for the 16 MB line below and takes tens of
  // seconds. The bound is ~1000x the fixed cost, so it only trips on a
  // reintroduced quadratic, not on a slow machine.
  it("stays linear for a 16 MB line split across 2000 chunks", async () => {
    const CHUNKS = 2000;
    const PER_CHUNK = 8192;
    const { stream } = lazySource(CHUNKS, () => "y".repeat(PER_CHUNK));
    const start = performance.now();
    let total = 0;
    for await (const line of streamLines(stream)) total += line.length;
    const elapsed = performance.now() - start;
    expect(total).toBe(CHUNKS * PER_CHUNK);
    expect(elapsed).toBeLessThan(3000);
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
