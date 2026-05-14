/**
 * ByteStream — the streaming binary I/O format used across just-bash.
 *
 * A ByteStream is a Web-standard ReadableStream<Uint8Array>. Streams replace
 * the previous single-Uint8Array I/O model: stdout/stderr/stdin and file
 * contents are streams of byte chunks, which removes the per-allocation
 * size cap and lets the pipeline backpressure-propagate.
 *
 * Storage of small things (env values, command args) is still Uint8Array —
 * those are tiny and need random access.
 *
 * Chunk size convention: producers emit chunks of up to 64 KiB. Consumers
 * MUST tolerate any chunk size including 0 (caller intent: keep going).
 */

import { concat as concatBytes, EMPTY, encode } from "./bytes.js";

export type ByteStream = ReadableStream<Uint8Array>;

/** Default chunk size for buffered → stream conversions */
export const CHUNK_SIZE: number = 64 * 1024;

/** An empty stream that closes immediately. */
export function emptyStream(): ByteStream {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
}

/** Wrap a single Uint8Array as a stream. Empty input → empty stream. */
export function fromBytes(bytes: Uint8Array): ByteStream {
  if (bytes.length === 0) return emptyStream();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      // For very large arrays, split into CHUNK_SIZE pieces so consumers
      // can process incrementally instead of holding the whole thing.
      if (bytes.length <= CHUNK_SIZE) {
        controller.enqueue(bytes);
      } else {
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
          controller.enqueue(
            bytes.subarray(
              i,
              Math.min(i + CHUNK_SIZE, bytes.length),
            ) as Uint8Array,
          );
        }
      }
      controller.close();
    },
  });
}

/** Wrap an array of chunks as a stream. */
export function fromChunks(chunks: Uint8Array[]): ByteStream {
  if (chunks.length === 0) return emptyStream();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        if (c.length > 0) controller.enqueue(c);
      }
      controller.close();
    },
  });
}

/** Encode a string and wrap as a stream. */
export function fromString(s: string): ByteStream {
  if (s.length === 0) return emptyStream();
  return fromBytes(encode(s));
}

/**
 * Consume a stream to a single Uint8Array.
 *
 * This DEFEATS streaming — only use when a command genuinely needs the full
 * input in memory (sort, awk, sed with multi-line patterns). Total size is
 * capped at maxBytes (default: no cap) to surface runaway buffering.
 */
export async function collectBytes(
  stream: ByteStream,
  maxBytes?: number,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      if (maxBytes !== undefined && total > maxBytes) {
        throw new Error(
          `stream exceeded maxBytes=${maxBytes} (collected ${total})`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 0) return EMPTY;
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out as Uint8Array;
}

/** Consume a stream as a UTF-8 string. */
export async function collectText(stream: ByteStream): Promise<string> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let out = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length > 0) {
        out += decoder.decode(value, { stream: true });
      }
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

/** Concatenate two streams: emit all chunks of `a`, then all of `b`. */
export function concatStreams(a: ByteStream, b: ByteStream): ByteStream {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const drain = async (s: ByteStream) => {
        const r = s.getReader();
        try {
          while (true) {
            const { done, value } = await r.read();
            if (done) break;
            if (value && value.length > 0) controller.enqueue(value);
          }
        } finally {
          r.releaseLock();
        }
      };
      try {
        await drain(a);
        await drain(b);
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}

/** Tee a stream into two independent streams (e.g. for |&). */
export function teeStream(s: ByteStream): [ByteStream, ByteStream] {
  return s.tee();
}

/**
 * Async-iterate over the chunks of a stream.
 * Convenience for `for await (const chunk of streamChunks(s))`.
 */
export async function* streamChunks(
  s: ByteStream,
): AsyncIterableIterator<Uint8Array> {
  const reader = s.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value && value.length > 0) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Split a stream into lines (LF-delimited). Yields each line WITHOUT the
 * trailing newline. A trailing partial line (no LF) is yielded last.
 *
 * Useful for line-oriented streaming commands like grep, head, tail.
 */
export async function* streamLines(
  s: ByteStream,
): AsyncIterableIterator<Uint8Array> {
  let leftover: Uint8Array = EMPTY;
  for await (const chunk of streamChunks(s)) {
    let buf: Uint8Array = chunk;
    if (leftover.length > 0) {
      buf = concatBytes(leftover, chunk);
      leftover = EMPTY;
    }
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] === 0x0a) {
        yield buf.subarray(start, i) as Uint8Array;
        start = i + 1;
      }
    }
    if (start < buf.length) {
      leftover = buf.subarray(start) as Uint8Array;
    }
  }
  if (leftover.length > 0) yield leftover;
}

/**
 * Create a writable sink that collects chunks into a Uint8Array[].
 * Useful for writing to in-memory file storage.
 */
export function makeChunkSink(): {
  writable: WritableStream<Uint8Array>;
  chunks: Uint8Array[];
} {
  const chunks: Uint8Array[] = [];
  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      if (chunk.length > 0) chunks.push(chunk);
    },
  });
  return { writable, chunks };
}

/** Drain a stream to /dev/null (consume and discard). */
export async function drain(s: ByteStream): Promise<void> {
  const reader = s.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Map each chunk through `fn` and emit the result. `fn` may return null
 * to drop the chunk.
 */
export function mapChunks(
  s: ByteStream,
  fn: (chunk: Uint8Array) => Uint8Array | null,
): ByteStream {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of streamChunks(s)) {
          const out = fn(chunk);
          if (out !== null && out.length > 0) controller.enqueue(out);
        }
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
  });
}
