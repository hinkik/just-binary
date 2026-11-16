/**
 * The stream constructors the package exports.
 *
 * Inside the library these build cheap in-memory streams. Callers outside it
 * may hand the result to a platform API (`new Response(stream)`, a transfer),
 * which accepts only platform streams, so the exported constructors return
 * those.
 */

import {
  type ByteStream,
  emptyStream as internalEmptyStream,
  fromBytes as internalFromBytes,
  fromChunks as internalFromChunks,
  fromString as internalFromString,
  toNativeStream,
} from "./stream.js";

/** An empty stream that closes immediately. */
export function emptyStream(): ByteStream {
  return toNativeStream(internalEmptyStream());
}

/** Wrap a single Uint8Array as a stream. */
export function fromBytes(bytes: Uint8Array): ByteStream {
  return toNativeStream(internalFromBytes(bytes));
}

/** Wrap an array of chunks as a stream. */
export function fromChunks(chunks: Uint8Array[]): ByteStream {
  return toNativeStream(internalFromChunks(chunks));
}

/** Encode a string and wrap as a stream. */
export function fromString(s: string): ByteStream {
  return toNativeStream(internalFromString(s));
}
