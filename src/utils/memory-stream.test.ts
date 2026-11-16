import { describe, expect, it } from "vitest";
import {
  CHUNK_SIZE,
  collectBytes,
  collectText,
  concatStreams,
  emptyStream,
  fromBytes,
  fromChunks,
  fromString,
  fromTextLazy,
  isKnownEmptyStream,
  streamTextLineBatches,
  takeBufferedText,
  toNativeStream,
} from "./stream.js";

describe("in-memory streams", () => {
  it("read like a ReadableStream", async () => {
    const stream = fromString("hello");
    expect(stream instanceof ReadableStream).toBe(true);
    expect(stream.locked).toBe(false);
    const reader = stream.getReader();
    expect(stream.locked).toBe(true);
    expect(() => stream.getReader()).toThrow(TypeError);
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe("hello");
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
    expect(stream.locked).toBe(false);
  });

  it("hand out large buffers in chunk-sized pieces", async () => {
    const sizes: number[] = [];
    for await (const chunk of fromBytes(new Uint8Array(CHUNK_SIZE * 2 + 5))) {
      sizes.push(chunk.length);
    }
    expect(sizes).toEqual([CHUNK_SIZE, CHUNK_SIZE, 5]);
  });

  it("support tee, cancel and early exit from iteration", async () => {
    const [a, b] = fromChunks([new Uint8Array([1]), new Uint8Array([2])]).tee();
    expect(Array.from(await collectBytes(a))).toEqual([1, 2]);
    expect(Array.from(await collectBytes(b))).toEqual([1, 2]);

    const cancelled = fromString("abc");
    await cancelled.cancel();
    expect(await collectText(cancelled)).toBe("");

    const partial = fromChunks([new Uint8Array([1]), new Uint8Array([2])]);
    for await (const _chunk of partial) break;
    expect(isKnownEmptyStream(partial)).toBe(true);
  });

  it("know when they are empty", async () => {
    expect(isKnownEmptyStream(emptyStream())).toBe(true);
    const stream = fromString("x");
    expect(isKnownEmptyStream(stream)).toBe(false);
    await collectBytes(stream);
    expect(isKnownEmptyStream(stream)).toBe(true);
    expect(
      await collectText(concatStreams(emptyStream(), fromString("b"))),
    ).toBe("b");
  });

  it("convert lazily to a platform stream", async () => {
    const source = fromString("payload");
    const native = toNativeStream(source);
    // Nothing is taken until the platform stream is read.
    expect(isKnownEmptyStream(source)).toBe(false);
    expect(await new Response(native).text()).toBe("payload");
    expect(isKnownEmptyStream(source)).toBe(true);
  });

  it("carry text that is encoded only when bytes are read", async () => {
    const taken = fromTextLazy("line one\nline two\n");
    expect(isKnownEmptyStream(taken)).toBe(false);
    expect(takeBufferedText(taken)).toBe("line one\nline two\n");
    expect(isKnownEmptyStream(taken)).toBe(true);

    expect(await collectText(fromTextLazy("héllo"))).toBe("héllo");
    expect(takeBufferedText(fromString("bytes"))).toBeNull();
  });
});

describe("streamTextLineBatches", () => {
  const lines = async (chunks: Uint8Array[]): Promise<string[]> => {
    const out: string[] = [];
    for await (const batch of streamTextLineBatches(fromChunks(chunks))) {
      out.push(...batch);
    }
    return out;
  };
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("splits on newlines across chunk boundaries", async () => {
    expect(await lines([bytes("a\nb"), bytes("c\n\nd")])).toEqual([
      "a",
      "bc",
      "",
      "d",
    ]);
    expect(await lines([bytes("only\n")])).toEqual(["only"]);
    expect(await lines([])).toEqual([]);
  });

  it("keeps a multi-byte character split between chunks whole", async () => {
    const encoded = bytes("é\nü\n");
    expect(await lines([encoded.subarray(0, 1), encoded.subarray(1)])).toEqual([
      "é",
      "ü",
    ]);
  });

  it("drops a byte order mark at the start of a line", async () => {
    expect(await lines([bytes("﻿a\n﻿b\n")])).toEqual(["a", "b"]);
  });
});

describe("streams handed to embedders", () => {
  it("are platform streams for file contents", async () => {
    const { Bash } = await import("../Bash.js");
    const bash = new Bash();
    await bash.writeFile("/f", "filedata");
    const stream = await bash.fs.readFile("/f");
    expect(await new Response(stream).text()).toBe("filedata");
  });
});
