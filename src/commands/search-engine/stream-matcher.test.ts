import { describe, expect, it } from "vitest";
import { createUserRegex } from "../../regex/index.js";
import { encode } from "../../utils/bytes.js";
import type { ByteStream } from "../../utils/stream.js";
import { streamHasMatch } from "./stream-matcher.js";

function fromStrings(chunks: string[]): ByteStream {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encode(chunks[i++]));
    },
  }) as ByteStream;
}

describe("streamHasMatch", () => {
  it("finds a literal within a chunk", async () => {
    const regex = createUserRegex("needle", "g");
    expect(
      await streamHasMatch(fromStrings(["hay\nneedle here\nhay\n"]), regex),
    ).toBe(true);
    expect(await streamHasMatch(fromStrings(["hay\nhay\n"]), regex)).toBe(
      false,
    );
  });

  it("finds a literal split across chunk boundaries", async () => {
    const regex = createUserRegex("needle", "g");
    expect(
      await streamHasMatch(fromStrings(["aaa nee", "dle bbb\n"]), regex),
    ).toBe(true);
  });

  it("matches literal alternations case-insensitively", async () => {
    const regex = createUserRegex("foo|bar baz", "gi");
    expect(await streamHasMatch(fromStrings(["x\nBAR ", "BAZ\n"]), regex)).toBe(
      true,
    );
    expect(await streamHasMatch(fromStrings(["x\nbarbaz\n"]), regex)).toBe(
      false,
    );
  });

  it("empty pattern matches any line but not an empty file", async () => {
    const regex = createUserRegex("", "g");
    expect(await streamHasMatch(fromStrings(["x\n"]), regex)).toBe(true);
    expect(await streamHasMatch(fromStrings([]), regex)).toBe(false);
  });

  it("ignores alternation branches containing newlines", async () => {
    // "a\nb" can never match a single line; the "foo" branch still can.
    const regex = createUserRegex("a\\nb|foo", "g");
    expect(await streamHasMatch(fromStrings(["a\nb\n"]), regex)).toBe(false);
    expect(await streamHasMatch(fromStrings(["x foo y\n"]), regex)).toBe(true);
  });

  it("falls back to per-line matching for non-literal patterns", async () => {
    const regex = createUserRegex("^needle$", "g");
    expect(
      await streamHasMatch(fromStrings(["hay\nneedle\nhay\n"]), regex),
    ).toBe(true);
    expect(await streamHasMatch(fromStrings(["a needle b\n"]), regex)).toBe(
      false,
    );
  });
});
