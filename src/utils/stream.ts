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

// ============================================================================
// In-memory streams
// ============================================================================
// Nearly every stream the interpreter creates is a view over bytes that are
// already in memory: the empty stdout/stderr of a statement that wrote to its
// channels, a builtin's buffered output, a here-string. A WHATWG
// ReadableStream costs over a microsecond to construct and another per chunk
// read, which dominated the cost of running a simple command. MemoryStream
// offers the same reading surface (getReader, async iteration, cancel, tee,
// pipeTo, pipeThrough) over an array of chunks with no controller, queue or
// promise machinery behind it. It inherits from ReadableStream.prototype so
// `instanceof ReadableStream` holds, but it is NOT a platform stream: hand it
// to a platform API (Response, postMessage) via toNativeStream().

type ReadResult = ReadableStreamReadResult<Uint8Array>;

const DONE_RESULT: ReadResult = { done: true, value: undefined };

class MemoryStreamReader {
  private stream: MemoryStream | null;

  constructor(stream: MemoryStream) {
    this.stream = stream;
  }

  read(): Promise<ReadResult> {
    const stream = this.stream;
    if (stream === null) {
      return Promise.reject(new TypeError("Reader has been released"));
    }
    const chunk = stream.next();
    return Promise.resolve(
      chunk === null ? DONE_RESULT : { done: false, value: chunk },
    );
  }

  releaseLock(): void {
    if (this.stream !== null) {
      this.stream.isLocked = false;
      this.stream = null;
    }
  }

  cancel(): Promise<void> {
    this.stream?.discard();
    return Promise.resolve();
  }

  get closed(): Promise<undefined> {
    return Promise.resolve(undefined);
  }
}

class MemoryStream {
  private chunks: readonly Uint8Array[];
  private index = 0;
  /** Offset into the current chunk when it is being handed out in pieces. */
  private offset = 0;
  /**
   * Text this stream carries that has not been encoded yet. A reader that
   * wants text (the `read` builtin taking one line at a time) can take it as
   * it is; the bytes are produced only if something reads bytes.
   */
  private text: string | null = null;
  isLocked = false;

  constructor(chunks: readonly Uint8Array[], text: string | null = null) {
    this.chunks = chunks;
    this.text = text;
  }

  private encodeText(): void {
    const text = this.text;
    if (text !== null) {
      this.text = null;
      this.chunks = text.length === 0 ? NO_CHUNKS : [encode(text)];
    }
  }

  /** The not-yet-encoded text, taken whole; null when there is none. */
  takeText(): string | null {
    const text = this.text;
    if (text !== null) this.discard();
    return text;
  }

  /** Next non-empty piece of at most CHUNK_SIZE bytes, or null at the end. */
  next(): Uint8Array | null {
    if (this.text !== null) this.encodeText();
    const chunks = this.chunks;
    while (this.index < chunks.length) {
      const chunk = chunks[this.index];
      const remaining = chunk.length - this.offset;
      if (remaining <= 0) {
        this.index++;
        this.offset = 0;
        continue;
      }
      if (this.offset === 0 && remaining <= CHUNK_SIZE) {
        this.index++;
        return chunk;
      }
      const end = this.offset + Math.min(remaining, CHUNK_SIZE);
      const piece = chunk.subarray(this.offset, end) as Uint8Array;
      if (end === chunk.length) {
        this.index++;
        this.offset = 0;
      } else {
        this.offset = end;
      }
      return piece;
    }
    return null;
  }

  /** Everything not yet read, as whole chunks; the stream is left drained. */
  takeRemaining(): Uint8Array[] {
    if (this.text !== null) this.encodeText();
    const out: Uint8Array[] = [];
    const chunks = this.chunks;
    for (let i = this.index; i < chunks.length; i++) {
      const chunk =
        i === this.index && this.offset > 0
          ? (chunks[i].subarray(this.offset) as Uint8Array)
          : chunks[i];
      if (chunk.length > 0) out.push(chunk);
    }
    this.discard();
    return out;
  }

  get isDrained(): boolean {
    if (this.text !== null) return this.text.length === 0;
    for (let i = this.index; i < this.chunks.length; i++) {
      if (this.chunks[i].length - (i === this.index ? this.offset : 0) > 0) {
        return false;
      }
    }
    return true;
  }

  discard(): void {
    this.text = null;
    this.chunks = NO_CHUNKS;
    this.index = 0;
    this.offset = 0;
  }

  get locked(): boolean {
    return this.isLocked;
  }

  getReader(options?: { mode?: string }): MemoryStreamReader {
    if (options?.mode === "byob") {
      throw new TypeError("In-memory streams do not support BYOB readers");
    }
    if (this.isLocked) {
      throw new TypeError("ReadableStream is locked");
    }
    this.isLocked = true;
    return new MemoryStreamReader(this);
  }

  cancel(): Promise<void> {
    if (this.isLocked) {
      return Promise.reject(new TypeError("ReadableStream is locked"));
    }
    this.discard();
    return Promise.resolve();
  }

  tee(): [ByteStream, ByteStream] {
    if (this.isLocked) {
      throw new TypeError("ReadableStream is locked");
    }
    const remaining = this.takeRemaining();
    return [memoryStream(remaining), memoryStream(remaining)];
  }

  pipeTo(
    destination: WritableStream<Uint8Array>,
    options?: StreamPipeOptions,
  ): Promise<void> {
    return toNativeStream(this as unknown as ByteStream).pipeTo(
      destination,
      options,
    );
  }

  pipeThrough<T>(
    transform: ReadableWritablePair<T, Uint8Array>,
    options?: StreamPipeOptions,
  ): ReadableStream<T> {
    return toNativeStream(this as unknown as ByteStream).pipeThrough(
      transform,
      options,
    );
  }

  values(options?: {
    preventCancel?: boolean;
  }): AsyncIterableIterator<Uint8Array> {
    const reader = this.getReader();
    const preventCancel = options?.preventCancel === true;
    return {
      next: async () => {
        const result = await reader.read();
        if (result.done) {
          reader.releaseLock();
          return { done: true, value: undefined };
        }
        return { done: false, value: result.value };
      },
      return: async () => {
        if (!preventCancel) await reader.cancel();
        reader.releaseLock();
        return { done: true, value: undefined };
      },
      [Symbol.asyncIterator]() {
        return this;
      },
    } as AsyncIterableIterator<Uint8Array>;
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<Uint8Array> {
    return this.values();
  }
}

const NO_CHUNKS: readonly Uint8Array[] = [];

if (typeof ReadableStream !== "undefined") {
  Object.setPrototypeOf(MemoryStream.prototype, ReadableStream.prototype);
}

function memoryStream(chunks: readonly Uint8Array[]): ByteStream {
  return new MemoryStream(chunks) as unknown as ByteStream;
}

function asMemoryStream(stream: ByteStream): MemoryStream | null {
  return stream instanceof MemoryStream ? stream : null;
}

/** An empty stream that closes immediately. */
export function emptyStream(): ByteStream {
  return memoryStream(NO_CHUNKS);
}

/**
 * True when `stream` is known to yield no (more) bytes.
 * A false answer proves nothing — a platform stream may still be empty.
 */
export function isKnownEmptyStream(stream: ByteStream): boolean {
  return asMemoryStream(stream)?.isDrained === true;
}

/** True when `stream` is an in-memory stream rather than a platform one. */
export function isInMemoryStream(stream: ByteStream): boolean {
  return stream instanceof MemoryStream;
}

/**
 * The unread bytes of an unlocked in-memory stream, taken synchronously (the
 * stream is left drained), or null when `stream` is a platform stream or is
 * locked and so must be read through a reader.
 */
function takeBufferedChunks(stream: ByteStream): Uint8Array[] | null {
  const memory = asMemoryStream(stream);
  if (memory === null || memory.isLocked) return null;
  return memory.takeRemaining();
}

/** Wrap a single Uint8Array as a stream. Empty input → empty stream. */
export function fromBytes(bytes: Uint8Array): ByteStream {
  // Readers receive pieces of at most CHUNK_SIZE, so consumers can process a
  // very large array incrementally instead of holding the whole thing.
  return memoryStream(bytes.length === 0 ? NO_CHUNKS : [bytes]);
}

/** Wrap an array of chunks as a stream. */
export function fromChunks(chunks: Uint8Array[]): ByteStream {
  return memoryStream(chunks.length === 0 ? NO_CHUNKS : chunks.slice());
}

/** Encode a string and wrap as a stream. */
export function fromString(s: string): ByteStream {
  if (s.length === 0) return emptyStream();
  return fromBytes(encode(s));
}

/**
 * A stream of a string's UTF-8 bytes that encodes only when bytes are read.
 * A consumer that wants the text back can take it with takeBufferedText and
 * skip the encode and decode altogether.
 */
export function fromTextLazy(s: string): ByteStream {
  if (s.length === 0) return emptyStream();
  return new MemoryStream(NO_CHUNKS, s) as unknown as ByteStream;
}

/**
 * The whole content of a stream made by fromTextLazy, when none of it has
 * been read as bytes and the stream is unlocked; the stream is left drained.
 * Null for any other stream.
 */
export function takeBufferedText(stream: ByteStream): string | null {
  const memory = asMemoryStream(stream);
  if (memory === null || memory.isLocked) return null;
  return memory.takeText();
}

/**
 * A platform ReadableStream carrying the same bytes. Platform streams are
 * returned as they are. An in-memory stream is wrapped lazily: its bytes are
 * taken only as the result is read, so a wrapper nobody reads leaves the
 * source intact for whoever reads it next. Use this wherever a stream leaves
 * the library or meets a platform API.
 */
export function toNativeStream(stream: ByteStream): ByteStream {
  const memory = asMemoryStream(stream);
  if (memory === null) return stream;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const chunk = memory.next();
        if (chunk === null) {
          controller.close();
        } else {
          controller.enqueue(chunk);
        }
      },
      cancel() {
        memory.discard();
      },
    },
    { highWaterMark: 0 },
  );
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
  let chunks: Uint8Array[] = [];
  let total = 0;
  const buffered = takeBufferedChunks(stream);
  if (buffered !== null) {
    chunks = buffered;
    for (const chunk of chunks) total += chunk.length;
    if (maxBytes !== undefined && total > maxBytes) {
      throw new Error(
        `stream exceeded maxBytes=${maxBytes} (collected ${total})`,
      );
    }
  } else {
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

/** Concatenate two streams: emit all chunks of `a`, then all of `b`.
 *
 * Lazy: input streams are not opened (i.e. no reader is acquired) until
 * downstream pulls. This matters because the construction site is allowed
 * to keep the inputs unlocked and even hand `a` to another consumer — only
 * one of them will end up reading it, but neither call should fail at
 * construction time.
 */
export function concatStreams(a: ByteStream, b: ByteStream): ByteStream {
  // A drained in-memory stream can never yield bytes, so the other side is
  // the whole result.
  if (isKnownEmptyStream(a)) return b;
  if (isKnownEmptyStream(b)) return a;
  let stage: "a" | "b" | "done" = "a";
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      while (true) {
        if (stage === "done") {
          controller.close();
          return;
        }
        if (reader === null) {
          reader = (stage === "a" ? a : b).getReader();
        }
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          reader = null;
          stage = stage === "a" ? "b" : "done";
          continue;
        }
        if (value && value.length > 0) {
          controller.enqueue(value);
          return;
        }
      }
    },
    async cancel() {
      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // ignore
        }
        reader = null;
      }
    },
  });
}

/** Tee a stream into two independent streams (e.g. for |&). */
export function teeStream(s: ByteStream): [ByteStream, ByteStream] {
  return s.tee() as [ByteStream, ByteStream];
}

/**
 * Async-iterate over the chunks of a stream.
 * Convenience for `for await (const chunk of streamChunks(s))`.
 */
export async function* streamChunks(
  s: ByteStream,
): AsyncIterableIterator<Uint8Array> {
  const reader = s.getReader();
  let exhausted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        return;
      }
      if (value && value.length > 0) yield value;
    }
  } finally {
    if (!exhausted) {
      // The consumer stopped early (break/return/throw). Cancel the stream
      // so lazy sources (real files, OPFS handles) stop producing and
      // release their underlying resources, instead of dangling until GC.
      try {
        await reader.cancel();
      } catch {
        // Cancellation failures are not actionable for the consumer.
      }
    }
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
 * The lines of a stream as text, a batch per input chunk.
 *
 * Yields the same lines as decoding each line of streamLines() on its own —
 * split on LF, a trailing partial line included, a UTF-8 byte order mark at
 * the start of a line dropped — but hands them over a chunk at a time. A
 * consumer loops over each batch synchronously instead of suspending once
 * per line, which is what makes line-oriented commands slow on large input.
 */
export async function* streamTextLineBatches(
  s: ByteStream,
): AsyncIterableIterator<string[]> {
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const toLines = (bytes: Uint8Array): string[] => {
    const lines = decoder.decode(bytes).split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].charCodeAt(0) === 0xfeff) lines[i] = lines[i].slice(1);
    }
    return lines;
  };
  // The unfinished last line, kept as unjoined pieces: joining it onto every
  // arriving chunk would re-copy it each time, which is quadratic for one
  // very long line. Each byte is copied at most once, when its line ends.
  let pending: Uint8Array[] = [];
  let pendingLength = 0;
  const join = (last: Uint8Array): Uint8Array => {
    if (pendingLength === 0) return last;
    const out = new Uint8Array(pendingLength + last.length);
    let at = 0;
    for (const piece of pending) {
      out.set(piece, at);
      at += piece.length;
    }
    out.set(last, at);
    return out;
  };
  for await (const chunk of streamChunks(s)) {
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline === -1) {
      pending.push(chunk);
      pendingLength += chunk.length;
      continue;
    }
    // A batch always ends at a newline, so no UTF-8 sequence is cut in two.
    const complete = join(chunk.subarray(0, lastNewline) as Uint8Array);
    const rest = chunk.subarray(lastNewline + 1) as Uint8Array;
    pending = rest.length > 0 ? [rest] : [];
    pendingLength = rest.length;
    yield toLines(complete);
  }
  if (pendingLength > 0) yield toLines(join(EMPTY));
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
