/**
 * Shared helpers for readRange implementations across filesystem backends.
 */

export function validateRange(offset: number, length: number): void {
  if (!Number.isFinite(offset) || !Number.isInteger(offset) || offset < 0) {
    throw new Error(
      `EINVAL: invalid offset (must be a non-negative integer): ${offset}`,
    );
  }
  if (!Number.isFinite(length) || !Number.isInteger(length) || length < 0) {
    throw new Error(
      `EINVAL: invalid length (must be a non-negative integer): ${length}`,
    );
  }
}

/**
 * Slice a contiguous byte range out of a chunked file representation. Walks
 * chunks lazily; only the requested bytes are copied into the output. If the
 * requested range extends past `totalSize`, the result is truncated.
 */
export function sliceChunks(
  chunks: Uint8Array[],
  totalSize: number,
  offset: number,
  length: number,
): Uint8Array {
  if (offset >= totalSize || length === 0) {
    return new Uint8Array(0);
  }
  const end = Math.min(offset + length, totalSize);
  const outLen = end - offset;
  const out = new Uint8Array(outLen);

  let written = 0;
  let chunkStart = 0;
  for (const chunk of chunks) {
    if (written >= outLen) break;
    const chunkEnd = chunkStart + chunk.length;
    if (chunkEnd > offset && chunkStart < end) {
      const sliceStart = Math.max(0, offset - chunkStart);
      const sliceEnd = Math.min(chunk.length, end - chunkStart);
      const piece = chunk.subarray(sliceStart, sliceEnd);
      out.set(piece, written);
      written += piece.length;
    }
    chunkStart = chunkEnd;
  }

  return out;
}
