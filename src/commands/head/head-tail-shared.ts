/**
 * Shared utilities for head and tail commands.
 */

import type { CommandContext, ExecResult } from "../../types.js";
import {
  type ByteStream,
  collectText,
  emptyStream,
  fromBytes,
  fromChunks,
  fromString,
  streamChunks,
} from "../../utils/stream.js";
import { unknownOption } from "../help.js";

export interface HeadTailOptions {
  lines: number;
  bytes: number | null;
  quiet: boolean;
  verbose: boolean;
  files: string[];
  /** tail-specific: start from line N instead of last N lines */
  fromLine?: boolean;
}

export type HeadTailParseResult =
  | { ok: true; options: HeadTailOptions }
  | { ok: false; error: ExecResult };

/**
 * Parse head/tail command arguments.
 * Both commands share most options, with tail having additional +N syntax.
 */
export function parseHeadTailArgs(
  args: string[],
  cmdName: "head" | "tail",
): HeadTailParseResult {
  let lines = 10;
  let bytes: number | null = null;
  let quiet = false;
  let verbose = false;
  let fromLine = false;
  const files: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-n" && i + 1 < args.length) {
      const nextArg = args[++i];
      // tail supports +N syntax
      if (cmdName === "tail" && nextArg.startsWith("+")) {
        fromLine = true;
        lines = parseInt(nextArg.slice(1), 10);
      } else {
        lines = parseInt(nextArg, 10);
      }
    } else if (cmdName === "tail" && arg.startsWith("-n+")) {
      fromLine = true;
      lines = parseInt(arg.slice(3), 10);
    } else if (arg.startsWith("-n")) {
      lines = parseInt(arg.slice(2), 10);
    } else if (arg === "-c" && i + 1 < args.length) {
      bytes = parseInt(args[++i], 10);
    } else if (arg.startsWith("-c")) {
      bytes = parseInt(arg.slice(2), 10);
    } else if (arg.startsWith("--bytes=")) {
      bytes = parseInt(arg.slice(8), 10);
    } else if (arg.startsWith("--lines=")) {
      lines = parseInt(arg.slice(8), 10);
    } else if (arg === "-q" || arg === "--quiet" || arg === "--silent") {
      quiet = true;
    } else if (arg === "-v" || arg === "--verbose") {
      verbose = true;
    } else if (arg.match(/^-\d+$/)) {
      lines = parseInt(arg.slice(1), 10);
    } else if (arg.startsWith("--")) {
      return { ok: false, error: unknownOption(cmdName, arg) };
    } else if (arg.startsWith("-") && arg !== "-") {
      return { ok: false, error: unknownOption(cmdName, arg) };
    } else {
      files.push(arg);
    }
  }

  // Validate bytes
  if (bytes !== null && (Number.isNaN(bytes) || bytes < 0)) {
    return {
      ok: false,
      error: {
        stdout: emptyStream(),
        stderr: fromString(`${cmdName}: invalid number of bytes\n`),
        exitCode: 1,
      },
    };
  }

  // Validate lines
  if (Number.isNaN(lines) || lines < 0) {
    return {
      ok: false,
      error: {
        stdout: emptyStream(),
        stderr: fromString(`${cmdName}: invalid number of lines\n`),
        exitCode: 1,
      },
    };
  }

  return {
    ok: true,
    options: { lines, bytes, quiet, verbose, files, fromLine },
  };
}

/**
 * Process files for head/tail commands. Stream-based to handle files larger
 * than the V8 string cap. Head exits early once N bytes/lines are emitted;
 * tail uses a ring-buffer of bytes/lines.
 */
export async function processHeadTailFiles(
  ctx: CommandContext,
  options: HeadTailOptions,
  cmdName: "head" | "tail",
  _contentProcessor: (content: string) => string,
): Promise<ExecResult> {
  const { quiet, verbose, files, lines, bytes, fromLine } = options;

  const showHeaders = verbose || (!quiet && files.length > 1);
  const streams: ByteStream[] = [];
  let stderr = "";
  let exitCode = 0;

  const getStream = async (file: string): Promise<ByteStream> => {
    if (cmdName === "head") {
      if (bytes !== null) return headBytesStream(file, lines, bytes, ctx, file);
      return headLinesStream(file, lines, ctx);
    }
    // tail
    if (bytes !== null) return tailBytesStream(file, bytes, ctx);
    return tailLinesStream(file, lines, fromLine ?? false, ctx);
  };

  if (files.length === 0) {
    // stdin
    const stream =
      cmdName === "head"
        ? bytes !== null
          ? streamHeadBytes(ctx.stdin, bytes)
          : streamHeadLines(ctx.stdin, lines)
        : bytes !== null
          ? await streamTailBytes(ctx.stdin, bytes)
          : await streamTailLines(ctx.stdin, lines, fromLine ?? false);
    return { stdout: stream, stderr: emptyStream(), exitCode: 0 };
  }

  let filesProcessed = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      const stream = await getStream(file);
      if (showHeaders) {
        const header =
          filesProcessed > 0 ? `\n==> ${file} <==\n` : `==> ${file} <==\n`;
        streams.push(fromString(header));
      }
      streams.push(stream);
      filesProcessed++;
    } catch {
      stderr += `${cmdName}: ${file}: No such file or directory\n`;
      exitCode = 1;
    }
  }

  return {
    stdout: streams.length === 0 ? emptyStream() : concatAll(streams),
    stderr: fromString(stderr),
    exitCode,
  };
}

function concatAll(streams: ByteStream[]): ByteStream {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const s of streams) {
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
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

// --- head: file ---
async function headBytesStream(
  file: string,
  _lines: number,
  bytes: number,
  ctx: CommandContext,
  _orig: string,
): Promise<ByteStream> {
  const stream = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
  return streamHeadBytes(stream, bytes);
}
async function headLinesStream(
  file: string,
  lines: number,
  ctx: CommandContext,
): Promise<ByteStream> {
  const stream = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
  return streamHeadLines(stream, lines);
}

// --- tail: file ---
async function tailBytesStream(
  file: string,
  bytes: number,
  ctx: CommandContext,
): Promise<ByteStream> {
  const stream = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
  return streamTailBytes(stream, bytes);
}
async function tailLinesStream(
  file: string,
  lines: number,
  fromLine: boolean,
  ctx: CommandContext,
): Promise<ByteStream> {
  const stream = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
  return streamTailLines(stream, lines, fromLine);
}

// --- streaming primitives ---

/** Emit at most `maxBytes` bytes from `stream`, then close. */
function streamHeadBytes(stream: ByteStream, maxBytes: number): ByteStream {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let remaining = maxBytes;
      try {
        if (remaining > 0) {
          for await (const chunk of streamChunks(stream)) {
            if (remaining <= 0) break;
            if (chunk.length <= remaining) {
              controller.enqueue(chunk);
              remaining -= chunk.length;
            } else {
              controller.enqueue(chunk.subarray(0, remaining) as Uint8Array);
              remaining = 0;
              break;
            }
          }
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/** Emit up to `maxLines` lines from `stream`, then close. */
function streamHeadLines(stream: ByteStream, maxLines: number): ByteStream {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let linesEmitted = 0;
      let lastByte: number | null = null;
      let emittedAny = false;
      try {
        if (maxLines > 0) {
          for await (const chunk of streamChunks(stream)) {
            // Count newlines in chunk; if maxLines reached, emit up to and
            // including that newline.
            for (let i = 0; i < chunk.length; i++) {
              if (chunk[i] === 0x0a) {
                linesEmitted++;
                if (linesEmitted >= maxLines) {
                  const slice = chunk.subarray(0, i + 1) as Uint8Array;
                  controller.enqueue(slice);
                  controller.close();
                  return;
                }
              }
            }
            if (chunk.length > 0) {
              controller.enqueue(chunk);
              emittedAny = true;
              lastByte = chunk[chunk.length - 1];
            }
          }
        }
        // If we emitted partial content without a trailing newline, append one
        // to match real `head` (and prior just-bash) behavior on incomplete
        // final lines.
        if (emittedAny && lastByte !== null && lastByte !== 0x0a) {
          controller.enqueue(new Uint8Array([0x0a]) as Uint8Array);
        }
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}

/** Keep last `maxBytes` bytes via a ring buffer. */
async function streamTailBytes(
  stream: ByteStream,
  maxBytes: number,
): Promise<ByteStream> {
  if (maxBytes === 0) return emptyStream();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of streamChunks(stream)) {
    chunks.push(chunk);
    total += chunk.length;
    // Trim from the head while we have more than maxBytes.
    while (total - (chunks[0]?.length ?? 0) >= maxBytes) {
      total -= chunks[0].length;
      chunks.shift();
    }
  }
  if (total <= maxBytes) return fromChunks(chunks);
  // Trim the first chunk to keep exactly maxBytes total.
  const excess = total - maxBytes;
  chunks[0] = chunks[0].subarray(excess) as Uint8Array;
  return fromChunks(chunks);
}

/** Keep last `maxLines` lines, or skip first (maxLines-1) when `fromLine`. */
async function streamTailLines(
  stream: ByteStream,
  maxLines: number,
  fromLine: boolean,
): Promise<ByteStream> {
  if (fromLine) {
    // Skip first (maxLines - 1) lines, emit the rest.
    const out: Uint8Array[] = [];
    let skipped = 0;
    let stillSkipping = maxLines > 1;
    for await (const chunk of streamChunks(stream)) {
      if (!stillSkipping) {
        out.push(chunk);
        continue;
      }
      // Walk the chunk counting newlines until we've skipped enough.
      let i = 0;
      while (i < chunk.length && skipped < maxLines - 1) {
        if (chunk[i] === 0x0a) skipped++;
        i++;
      }
      if (skipped >= maxLines - 1) {
        stillSkipping = false;
        if (i < chunk.length) out.push(chunk.subarray(i) as Uint8Array);
      }
    }
    if (out.length === 0) {
      // tail -n +N past EOF still emits a trailing newline to match
      // legacy behavior.
      return fromBytes(new Uint8Array([0x0a]) as Uint8Array);
    }
    // Real tail ensures trailing newline.
    const last = out[out.length - 1];
    if (last.length > 0 && last[last.length - 1] !== 0x0a) {
      out.push(new TextEncoder().encode("\n") as Uint8Array);
    }
    return fromChunks(out);
  }

  if (maxLines === 0) return emptyStream();

  // Ring-buffer of bytes; track newline positions and discard chunks once
  // we have well over maxLines (twice for safety).
  const chunks: Uint8Array[] = [];
  let newlineCount = 0;
  for await (const chunk of streamChunks(stream)) {
    chunks.push(chunk);
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0x0a) newlineCount++;
    }
    // Drop front chunks while we'd still have at least maxLines newlines
    // without them.
    while (chunks.length > 1) {
      let frontNewlines = 0;
      for (let i = 0; i < chunks[0].length; i++) {
        if (chunks[0][i] === 0x0a) frontNewlines++;
      }
      if (newlineCount - frontNewlines < maxLines) break;
      newlineCount -= frontNewlines;
      chunks.shift();
    }
  }

  if (chunks.length === 0) return emptyStream();
  // Compact and find the start of the last `maxLines` lines.
  const merged = mergeChunks(chunks);
  let pos = merged.length;
  // If last byte is a newline, decrement first so we don't count it as a line.
  if (pos > 0 && merged[pos - 1] === 0x0a) pos--;
  let seen = 0;
  while (pos > 0 && seen < maxLines) {
    pos--;
    if (merged[pos] === 0x0a) {
      seen++;
      if (seen === maxLines) {
        pos++;
        break;
      }
    }
  }
  const slice = merged.subarray(pos) as Uint8Array;
  // Ensure trailing newline.
  if (slice.length > 0 && slice[slice.length - 1] !== 0x0a) {
    const out = new Uint8Array(slice.length + 1);
    out.set(slice);
    out[slice.length] = 0x0a;
    return fromBytes(out as Uint8Array);
  }
  return fromBytes(slice);
}

function mergeChunks(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out as Uint8Array;
}

// `collectText` retained import for backward compat (other commands may use this file).
void collectText;

/**
 * Get the first N lines or bytes from content.
 */
export function getHead(
  content: string,
  lines: number,
  bytes: number | null,
): string {
  if (bytes !== null) {
    return content.slice(0, bytes);
  }

  if (lines === 0) return "";

  let pos = 0;
  let lineCount = 0;
  const len = content.length;

  while (pos < len && lineCount < lines) {
    const nextNewline = content.indexOf("\n", pos);
    if (nextNewline === -1) {
      // No more newlines, rest of content is last line
      return `${content}\n`;
    }
    lineCount++;
    pos = nextNewline + 1;
  }

  return pos > 0 ? content.slice(0, pos) : "";
}

/**
 * Get the last N lines or bytes from content.
 */
export function getTail(
  content: string,
  lines: number,
  bytes: number | null,
  fromLine: boolean,
): string {
  if (bytes !== null) {
    return content.slice(-bytes);
  }

  const len = content.length;
  if (len === 0) return "";

  // For fromLine (+n), count from start
  if (fromLine) {
    let pos = 0;
    let lineCount = 1;
    while (pos < len && lineCount < lines) {
      const nextNewline = content.indexOf("\n", pos);
      if (nextNewline === -1) break;
      lineCount++;
      pos = nextNewline + 1;
    }
    const result = content.slice(pos);
    return result.endsWith("\n") ? result : `${result}\n`;
  }

  if (lines === 0) return "";

  // Scan backwards to find last N newlines
  let pos = len - 1;
  if (content[pos] === "\n") pos--;

  let lineCount = 0;
  while (pos >= 0 && lineCount < lines) {
    if (content[pos] === "\n") {
      lineCount++;
      if (lineCount === lines) {
        pos++;
        break;
      }
    }
    pos--;
  }

  if (pos < 0) pos = 0;
  const result = content.slice(pos);
  return content[len - 1] === "\n" ? result : `${result}\n`;
}
