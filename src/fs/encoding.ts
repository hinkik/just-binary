/**
 * Shared utilities for filesystem implementations.
 *
 * Provides encoding helpers for translating between the FileContent union
 * type (string | Uint8Array | ByteStream) and the internal chunked storage
 * format used by in-memory filesystems.
 */

import { uint8ToBinaryString } from "../utils/binary-string.js";
import { type ByteStream, CHUNK_SIZE, streamChunks } from "../utils/stream.js";
import type {
  BufferEncoding,
  FileContent,
  ReadFileOptions,
  WriteFileOptions,
} from "./interface.js";

// Text encoder for encoding conversions
const textEncoder = new TextEncoder();

/**
 * Type guard: is this a ReadableStream of bytes?
 */
function isByteStream(value: unknown): value is ByteStream {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { getReader?: unknown }).getReader === "function"
  );
}

/**
 * Convert a string/Uint8Array using the requested encoding to raw bytes.
 * Streams are NOT handled here — they need async collection.
 */
function encodedToBytes(
  content: string | Uint8Array,
  encoding?: BufferEncoding,
): Uint8Array {
  if (content instanceof Uint8Array) {
    return content;
  }

  if (encoding === "base64") {
    return Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
  }
  if (encoding === "hex") {
    const bytes = new Uint8Array(content.length / 2);
    for (let i = 0; i < content.length; i += 2) {
      bytes[i / 2] = parseInt(content.slice(i, i + 2), 16);
    }
    return bytes;
  }
  if (encoding === "binary" || encoding === "latin1") {
    // Chunked to avoid spread overhead for very long strings.
    const chunkSize = 65536;
    if (content.length <= chunkSize) {
      return Uint8Array.from(content, (c) => c.charCodeAt(0));
    }
    const result = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      result[i] = content.charCodeAt(i);
    }
    return result;
  }
  // Default to UTF-8 for text content
  return textEncoder.encode(content);
}

/**
 * Split a single Uint8Array into chunks of up to CHUNK_SIZE bytes.
 * Each chunk references a subarray of the original buffer (no extra copies).
 */
function splitIntoChunks(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length === 0) return [];
  if (bytes.length <= CHUNK_SIZE) return [bytes];
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    out.push(
      bytes.subarray(i, Math.min(i + CHUNK_SIZE, bytes.length)) as Uint8Array,
    );
  }
  return out;
}

/**
 * Normalize a FileContent (sync only — no streams) to chunked storage.
 * Encoding is applied to string content. Used by sync init paths.
 */
export function contentToChunksSync(
  content: string | Uint8Array,
  encoding?: BufferEncoding,
): { chunks: Uint8Array[]; size: number } {
  const bytes = encodedToBytes(content, encoding);
  const chunks = splitIntoChunks(bytes);
  return { chunks, size: bytes.length };
}

/**
 * Normalize any FileContent (including streams) to chunked storage.
 * Streams are collected; chunks are re-split to enforce CHUNK_SIZE.
 */
export async function contentToChunks(
  content: FileContent,
  encoding?: BufferEncoding,
): Promise<{ chunks: Uint8Array[]; size: number }> {
  if (isByteStream(content)) {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (const chunk of streamChunks(content)) {
      // Re-split if a chunk happens to be larger than CHUNK_SIZE.
      if (chunk.length <= CHUNK_SIZE) {
        chunks.push(chunk);
        total += chunk.length;
      } else {
        for (const sub of splitIntoChunks(chunk)) {
          chunks.push(sub);
          total += sub.length;
        }
      }
    }
    return { chunks, size: total };
  }
  return contentToChunksSync(content, encoding);
}

/**
 * Decode a sequence of chunks to a string using the given encoding.
 * Uses TextDecoder with stream:true for UTF-8 across chunks.
 */
export function decodeChunks(
  chunks: readonly Uint8Array[],
  encoding?: BufferEncoding | null,
): string {
  if (encoding === "base64") {
    // Concat then encode — base64 needs full byte stream.
    return btoa(uint8ToBinaryString(concatChunks(chunks)));
  }
  if (encoding === "hex") {
    let out = "";
    for (const c of chunks) {
      for (let i = 0; i < c.length; i++) {
        out += c[i].toString(16).padStart(2, "0");
      }
    }
    return out;
  }
  if (encoding === "binary" || encoding === "latin1") {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(concatChunks(chunks)).toString(encoding);
    }
    const chunkSize = 65536;
    let result = "";
    for (const buf of chunks) {
      if (buf.length <= chunkSize) {
        result += String.fromCharCode(...buf);
      } else {
        for (let i = 0; i < buf.length; i += chunkSize) {
          const slice = buf.subarray(i, i + chunkSize);
          result += String.fromCharCode(...slice);
        }
      }
    }
    return result;
  }
  // UTF-8 / default: use streaming TextDecoder
  const decoder = new TextDecoder();
  let out = "";
  for (const c of chunks) {
    if (c.length > 0) out += decoder.decode(c, { stream: true });
  }
  out += decoder.decode();
  return out;
}

/** Concatenate chunks into a single Uint8Array. */
function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  if (total === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out as Uint8Array;
}

/**
 * Helper to get encoding from options
 */
export function getEncoding(
  options?: ReadFileOptions | WriteFileOptions | BufferEncoding | string | null,
): BufferEncoding | undefined {
  if (options === null || options === undefined) {
    return undefined;
  }
  if (typeof options === "string") {
    return options as BufferEncoding;
  }
  return options.encoding ?? undefined;
}
