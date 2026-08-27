import { describe, expect, it } from "vitest";
import { CHUNK_SIZE, fromBytes } from "../utils/stream.js";
import { contentToChunks, contentToChunksSync } from "./encoding.js";

/**
 * `subarray()` returns a VIEW that shares the parent ArrayBuffer, so storing a
 * small slice of a large buffer keeps the whole original alive. Stored chunks
 * outlive the command that produced them (the fs is session-scoped), so a small
 * file derived from a large one — `grep -o ... big.html > sig.html` — would pin
 * the original for the rest of the session, reporting only its own few bytes.
 *
 * These assert on `chunk.buffer.byteLength`, which is what actually stays
 * resident, rather than on `length`.
 */
function backingSizes(chunks: Uint8Array[]): number[] {
  return chunks.map((c) => c.buffer.byteLength);
}

describe("contentToChunksSync backing buffers", () => {
  it("detaches a small slice of a large buffer", () => {
    const big = new Uint8Array(4 * CHUNK_SIZE);
    const sliver = big.subarray(0, 20);
    const { chunks, size } = contentToChunksSync(sliver);
    expect(size).toBe(20);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].length).toBe(20);
    // Must not keep the 256 KB parent alive for a 20-byte file.
    expect(backingSizes(chunks)[0]).toBeLessThan(big.buffer.byteLength);
  });

  it("keeps a whole buffer copy-free", () => {
    const whole = new Uint8Array(1024);
    const { chunks } = contentToChunksSync(whole);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].buffer).toBe(whole.buffer);
  });

  it("splits a large whole buffer without copying it", () => {
    const whole = new Uint8Array(3 * CHUNK_SIZE);
    const { chunks, size } = contentToChunksSync(whole);
    expect(size).toBe(3 * CHUNK_SIZE);
    expect(chunks).toHaveLength(3);
    // Views over the original: total retained stays one buffer, not four.
    for (const c of chunks) expect(c.buffer).toBe(whole.buffer);
  });
});

describe("contentToChunks backing buffers (stream path)", () => {
  it("detaches when the stored bytes are a small slice of a large buffer", async () => {
    const big = new Uint8Array(4 * CHUNK_SIZE);
    const { chunks, size } = await contentToChunks(
      fromBytes(big.subarray(0, 20)),
    );
    expect(size).toBe(20);
    expect(backingSizes(chunks).every((b) => b < big.buffer.byteLength)).toBe(
      true,
    );
  });

  it("does not copy a full-size stream", async () => {
    const whole = new Uint8Array(3 * CHUNK_SIZE);
    const { chunks, size } = await contentToChunks(fromBytes(whole));
    expect(size).toBe(3 * CHUNK_SIZE);
    for (const c of chunks) expect(c.buffer).toBe(whole.buffer);
  });
});
