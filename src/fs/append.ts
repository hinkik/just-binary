import type { FileEntry } from "./interface.js";

/**
 * Small appends are coalesced into a tail buffer of at least this capacity
 * so `echo x >> f` loops don't create one chunk object per write.
 */
const TAIL_BUFFER_MIN = 4096;

/**
 * Append chunks to a file entry in place.
 *
 * Mutates `entry.chunks` (push) instead of rebuilding the array, so N
 * appends cost O(N) instead of O(N^2). Small chunks are written into a
 * spare-capacity tail buffer owned exclusively by this entry
 * (`entry.tailCapacity`). Readers are unaffected: they hold subarray views
 * of `[0, length)` and appends only ever write at offsets >= length of any
 * previously exposed view. Entry copies (cp/link) construct fresh objects
 * without `tailCapacity`, so they never write into a shared buffer.
 */
export function appendChunksToEntry(
  entry: FileEntry,
  newChunks: Uint8Array[],
  newSize: number,
): void {
  for (const chunk of newChunks) {
    if (chunk.length === 0) continue;
    if (chunk.length >= TAIL_BUFFER_MIN) {
      entry.chunks.push(chunk);
      entry.tailCapacity = undefined;
      continue;
    }
    const last = entry.chunks[entry.chunks.length - 1];
    const capacity = entry.tailCapacity ?? 0;
    if (last !== undefined && capacity >= last.length + chunk.length) {
      const buffer = new Uint8Array(last.buffer, last.byteOffset, capacity);
      buffer.set(chunk, last.length);
      entry.chunks[entry.chunks.length - 1] = new Uint8Array(
        last.buffer,
        last.byteOffset,
        last.length + chunk.length,
      );
    } else {
      const newCapacity = Math.max(TAIL_BUFFER_MIN, chunk.length);
      const buffer = new Uint8Array(newCapacity);
      buffer.set(chunk, 0);
      entry.chunks.push(buffer.subarray(0, chunk.length) as Uint8Array);
      entry.tailCapacity = newCapacity;
    }
  }
  entry.size += newSize;
  entry.mtime = new Date();
}
