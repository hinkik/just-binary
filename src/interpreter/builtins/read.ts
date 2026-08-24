/**
 * read - Read a line of input builtin
 */

import type { ExecResult } from "../../types.js";
import { EMPTY, encode, envSet } from "../../utils/bytes.js";
import {
  type ByteStream,
  emptyStream,
  isKnownEmptyStream,
} from "../../utils/stream.js";
import { clearArray } from "../helpers/array.js";
import {
  getIfs,
  splitByIfsForRead,
  stripTrailingIfsWhitespace,
} from "../helpers/ifs.js";
import { result } from "../helpers/result.js";
import type { InterpreterContext } from "../types.js";

/**
 * Parse the content of a read-write file descriptor.
 * Format: __rw__:pathLength:path:position:content
 */
function parseRwFdContent(fdContent: string): {
  path: string;
  position: number;
  content: string;
} | null {
  if (!fdContent.startsWith("__rw__:")) {
    return null;
  }
  const afterPrefix = fdContent.slice(7);
  const firstColonIdx = afterPrefix.indexOf(":");
  if (firstColonIdx === -1) return null;
  const pathLength = Number.parseInt(afterPrefix.slice(0, firstColonIdx), 10);
  if (Number.isNaN(pathLength) || pathLength < 0) return null;
  const pathStart = firstColonIdx + 1;
  const path = afterPrefix.slice(pathStart, pathStart + pathLength);
  const positionStart = pathStart + pathLength + 1;
  const remaining = afterPrefix.slice(positionStart);
  const posColonIdx = remaining.indexOf(":");
  if (posColonIdx === -1) return null;
  const position = Number.parseInt(remaining.slice(0, posColonIdx), 10);
  if (Number.isNaN(position) || position < 0) return null;
  const content = remaining.slice(posColonIdx + 1);
  return { path, position, content };
}

/**
 * Encode read-write file descriptor content.
 */
function encodeRwFdContent(
  path: string,
  position: number,
  content: string,
): string {
  return `__rw__:${path.length}:${path}:${position}:${content}`;
}

/**
 * Incremental text view over a ByteStream for the read builtin.
 *
 * Holds only the not-yet-consumed window as a decoded string and pulls more
 * chunks on demand. This keeps `while read line` O(line) per iteration
 * instead of collect-decode-re-encode of the entire remaining input per
 * line (which was quadratic and materialized whole files).
 */
class StdinTextReader {
  /** Decoded, not-yet-consumed input. Grows via pull(), shrinks via consume(). */
  pending = "";
  private source: ByteStream | null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private decoder = new TextDecoder();
  private exhausted: boolean;

  constructor(source: ByteStream | null) {
    this.source = source;
    this.exhausted = source === null;
  }

  static fromString(s: string): StdinTextReader {
    const r = new StdinTextReader(null);
    r.pending = s;
    return r;
  }

  /** Pull one chunk of the source into pending. False once exhausted. */
  async pull(): Promise<boolean> {
    if (this.exhausted || !this.source) return false;
    if (!this.reader) this.reader = this.source.getReader();
    const { done, value } = await this.reader.read();
    if (done) {
      this.pending += this.decoder.decode();
      this.reader.releaseLock();
      this.reader = null;
      this.exhausted = true;
      return false;
    }
    if (value && value.length > 0) {
      this.pending += this.decoder.decode(value, { stream: true });
    }
    return true;
  }

  /** Pull until pending is non-empty or the source is exhausted. */
  async hasAnyInput(): Promise<boolean> {
    while (this.pending.length === 0) {
      if (!(await this.pull())) return false;
    }
    return true;
  }

  consume(chars: number): void {
    this.pending = this.pending.substring(chars);
  }

  /**
   * The unconsumed remainder as a lazy stream: the pending window first,
   * then the rest of the source (decoded/re-encoded through the same
   * decoder so split multi-byte sequences stay intact).
   */
  remainderStream(): ByteStream {
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          while (true) {
            if (this.pending.length > 0) {
              const bytes = encode(this.pending);
              this.pending = "";
              controller.enqueue(bytes);
              return;
            }
            if (!(await this.pull())) {
              controller.close();
              return;
            }
          }
        },
        cancel: async () => {
          await this.cancelSource();
        },
      },
      // highWaterMark 0: pull only when a consumer actually reads. The
      // default (1) pulls eagerly at construction, which would race the
      // `read` builtin for the shared pending window.
      { highWaterMark: 0 },
    );
  }

  async cancelSource(): Promise<void> {
    if (this.exhausted) return;
    this.exhausted = true;
    try {
      if (this.reader) {
        await this.reader.cancel();
        this.reader.releaseLock();
        this.reader = null;
      } else if (this.source) {
        await this.source.cancel();
      }
    } catch {
      // Cancellation failures are not actionable.
    }
  }
}

/**
 * Maps a groupStdin stream to the incremental reader that owns it, so
 * consecutive `read` calls in a loop share one reader instead of each
 * draining and rebuilding the stream. Keyed weakly: when state swaps
 * groupStdin out, the old reader is simply collected.
 */
const groupStdinReaders = new WeakMap<ByteStream, StdinTextReader>();

export async function handleRead(
  ctx: InterpreterContext,
  args: string[],
  stdinStream: ByteStream,
  stdinSourceFd = -1,
): Promise<ExecResult> {
  // Parse options
  let raw = false;
  let delimiter = "\n";
  let _prompt = "";
  let nchars = -1; // -n option: number of characters to read (with IFS splitting)
  let ncharsExact = -1; // -N option: read exactly N characters (no processing)
  let arrayName: string | null = null; // -a option: read into array
  let fileDescriptor = -1; // -u option: read from file descriptor
  let timeout = -1; // -t option: timeout in seconds
  const varNames: string[] = [];

  let i = 0;
  let invalidNArg = false;

  // Helper to parse smooshed options like -rn1 or -rd ''
  const parseOption = (
    opt: string,
    argIndex: number,
  ): { nextArgIndex: number } => {
    let j = 1; // skip the '-'
    while (j < opt.length) {
      const ch = opt[j];
      if (ch === "r") {
        raw = true;
        j++;
      } else if (ch === "s") {
        // Silent - ignore in non-interactive mode
        j++;
      } else if (ch === "d") {
        // -d requires value: either rest of this arg or next arg
        if (j + 1 < opt.length) {
          delimiter = opt.substring(j + 1);
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          delimiter = args[argIndex + 1];
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "n") {
        // -n requires value: either rest of this arg or next arg
        if (j + 1 < opt.length) {
          const numStr = opt.substring(j + 1);
          nchars = Number.parseInt(numStr, 10);
          if (Number.isNaN(nchars) || nchars < 0) {
            invalidNArg = true;
            nchars = 0;
          }
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          nchars = Number.parseInt(args[argIndex + 1], 10);
          if (Number.isNaN(nchars) || nchars < 0) {
            invalidNArg = true;
            nchars = 0;
          }
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "N") {
        // -N requires value: either rest of this arg or next arg
        if (j + 1 < opt.length) {
          const numStr = opt.substring(j + 1);
          ncharsExact = Number.parseInt(numStr, 10);
          if (Number.isNaN(ncharsExact) || ncharsExact < 0) {
            invalidNArg = true;
            ncharsExact = 0;
          }
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          ncharsExact = Number.parseInt(args[argIndex + 1], 10);
          if (Number.isNaN(ncharsExact) || ncharsExact < 0) {
            invalidNArg = true;
            ncharsExact = 0;
          }
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "a") {
        // -a requires value: either rest of this arg or next arg
        if (j + 1 < opt.length) {
          arrayName = opt.substring(j + 1);
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          arrayName = args[argIndex + 1];
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "p") {
        // -p requires value: either rest of this arg or next arg
        if (j + 1 < opt.length) {
          _prompt = opt.substring(j + 1);
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          _prompt = args[argIndex + 1];
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "u") {
        // -u requires value: file descriptor number
        if (j + 1 < opt.length) {
          const numStr = opt.substring(j + 1);
          fileDescriptor = Number.parseInt(numStr, 10);
          if (Number.isNaN(fileDescriptor) || fileDescriptor < 0) {
            return { nextArgIndex: -2 }; // signal error (return exit code 1)
          }
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          fileDescriptor = Number.parseInt(args[argIndex + 1], 10);
          if (Number.isNaN(fileDescriptor) || fileDescriptor < 0) {
            return { nextArgIndex: -2 }; // signal error (return exit code 1)
          }
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "t") {
        // -t requires value: timeout in seconds (can be float)
        if (j + 1 < opt.length) {
          const numStr = opt.substring(j + 1);
          timeout = Number.parseFloat(numStr);
          if (Number.isNaN(timeout)) {
            timeout = 0;
          }
          return { nextArgIndex: argIndex + 1 };
        } else if (argIndex + 1 < args.length) {
          timeout = Number.parseFloat(args[argIndex + 1]);
          if (Number.isNaN(timeout)) {
            timeout = 0;
          }
          return { nextArgIndex: argIndex + 2 };
        }
        return { nextArgIndex: argIndex + 1 };
      } else if (ch === "e" || ch === "i" || ch === "P") {
        // Interactive options - skip (with potential argument for -i)
        if (ch === "i" && argIndex + 1 < args.length) {
          return { nextArgIndex: argIndex + 2 };
        }
        j++;
      } else {
        // Unknown option, skip
        j++;
      }
    }
    return { nextArgIndex: argIndex + 1 };
  };

  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("-") && arg.length > 1 && arg !== "--") {
      const parseResult = parseOption(arg, i);
      if (parseResult.nextArgIndex === -1) {
        // Invalid argument (e.g., unknown option) - return exit code 2
        return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 2 };
      }
      if (parseResult.nextArgIndex === -2) {
        // Invalid argument value (e.g., -u with negative number) - return exit code 1
        return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 1 };
      }
      i = parseResult.nextArgIndex;
    } else if (arg === "--") {
      i++;
      // Rest are variable names
      while (i < args.length) {
        varNames.push(args[i]);
        i++;
      }
    } else {
      varNames.push(arg);
      i++;
    }
  }

  // Return error if -n had invalid argument
  if (invalidNArg) {
    return result(EMPTY, EMPTY, 1);
  }

  // Default variable is REPLY
  if (varNames.length === 0 && arrayName === null) {
    varNames.push("REPLY");
  }

  // Note: prompt (-p) would typically output to terminal, but we ignore it in non-interactive mode

  // Handle -t 0: check if input is available without reading
  // In bash, -t 0 is a "poll" operation that always succeeds (returns 0) as long as
  // stdin is valid/readable. It doesn't actually read any data.
  if (timeout === 0) {
    // Clear any variables to empty (read doesn't actually read anything)
    if (arrayName) {
      clearArray(ctx, arrayName);
    } else {
      for (const name of varNames) {
        envSet(ctx.state.env, name, "");
      }
      if (varNames.length === 0) {
        envSet(ctx.state.env, "REPLY", "");
      }
    }
    return result(EMPTY, EMPTY, 0); // Always succeed - stdin is valid
  }

  // Handle negative timeout - bash returns exit code 1
  if (timeout < 0 && timeout !== -1) {
    return result(EMPTY, EMPTY, 1);
  }

  // Pick the input source, in priority order:
  //   -u N       → the file descriptor's string content
  //   parameter  → the command's own stdin (pipe, or `read x < file`)
  //   groupStdin → shared group/loop stdin (while read ...; done < file)
  let source: StdinTextReader;
  let usingGroupStdin = false;
  let fdInput = ""; // full -u fd content, for position tracking

  if (fileDescriptor >= 0) {
    fdInput = ctx.state.fileDescriptors?.get(fileDescriptor) || "";
    source = StdinTextReader.fromString(fdInput);
  } else {
    let paramReader: StdinTextReader | null = null;
    if (
      !isKnownEmptyStream(stdinStream) &&
      stdinStream !== ctx.state.groupStdin
    ) {
      paramReader = new StdinTextReader(stdinStream);
      if (!(await paramReader.hasAnyInput())) paramReader = null;
    }
    if (paramReader) {
      source = paramReader;
    } else if (ctx.state.groupStdin !== undefined) {
      usingGroupStdin = true;
      let reader = groupStdinReaders.get(ctx.state.groupStdin);
      if (!reader) {
        reader = new StdinTextReader(ctx.state.groupStdin);
        // Expose the unconsumed remainder as the new groupStdin so other
        // consumers (and the next `read`) see exactly what this one left.
        const remainder = reader.remainderStream();
        groupStdinReaders.set(remainder, reader);
        ctx.state.groupStdin = remainder;
      }
      source = reader;
    } else {
      source = StdinTextReader.fromString("");
    }
  }

  // Handle -d '' (empty delimiter) - reads until NUL byte
  // Empty string delimiter means read until NUL byte (\0)
  const effectiveDelimiter = delimiter === "" ? "\0" : delimiter;

  // Get input
  let line = "";
  let consumed = 0;
  let foundDelimiter = true; // Assume found unless no newline at end

  // Helper to consume from the appropriate source
  const consumeInput = (charsConsumed: number) => {
    if (fileDescriptor >= 0 && ctx.state.fileDescriptors) {
      ctx.state.fileDescriptors.set(
        fileDescriptor,
        fdInput.substring(charsConsumed),
      );
    } else if (stdinSourceFd >= 0 && ctx.state.fileDescriptors) {
      // Update the position of a read-write FD that was redirected to stdin
      const fdContent = ctx.state.fileDescriptors.get(stdinSourceFd);
      if (fdContent?.startsWith("__rw__:")) {
        const parsed = parseRwFdContent(fdContent);
        if (parsed) {
          // Advance position by charsConsumed
          const newPosition = parsed.position + charsConsumed;
          ctx.state.fileDescriptors.set(
            stdinSourceFd,
            encodeRwFdContent(parsed.path, newPosition, parsed.content),
          );
        }
      }
    } else if (usingGroupStdin) {
      // Drop only what this read consumed; the rest stays buffered in the
      // shared reader (no re-encode of the whole remaining input).
      source.consume(charsConsumed);
    }
  };

  try {
    if (ncharsExact >= 0) {
      // -N: Read exactly N characters (ignores delimiters, no IFS splitting)
      while (source.pending.length < ncharsExact && (await source.pull())) {
        // pull until we have N chars or EOF
      }
      const toRead = Math.min(ncharsExact, source.pending.length);
      line = source.pending.substring(0, toRead);
      consumed = toRead;
      foundDelimiter = toRead >= ncharsExact;

      // Consume from appropriate source
      consumeInput(consumed);

      // With -N, assign entire content to first variable (no IFS splitting)
      const varName = varNames[0] || "REPLY";
      envSet(ctx.state.env, varName, line);
      // Set remaining variables to empty
      for (let j = 1; j < varNames.length; j++) {
        envSet(ctx.state.env, varNames[j], "");
      }
      return result(EMPTY, EMPTY, foundDelimiter ? 0 : 1);
    } else if (nchars >= 0) {
      // -n: Read at most N characters (or until delimiter/EOF), then apply IFS splitting
      // In non-raw mode, backslash escapes are processed: \X counts as 1 char (the X)
      let charCount = 0;
      let inputPos = 0;
      let hitDelimiter = false;
      while (charCount < nchars) {
        if (inputPos >= source.pending.length) {
          if (await source.pull()) continue;
          break;
        }
        const char = source.pending[inputPos];
        if (char === effectiveDelimiter) {
          consumed = inputPos + 1;
          hitDelimiter = true;
          break;
        }
        if (
          !raw &&
          char === "\\" &&
          inputPos + 1 >= source.pending.length &&
          (await source.pull())
        ) {
          // The escaped character may be in the next chunk.
          continue;
        }
        if (!raw && char === "\\" && inputPos + 1 < source.pending.length) {
          // Backslash escape: consume both chars, but only count as 1 char
          // The escaped character is kept, backslash is removed
          const nextChar = source.pending[inputPos + 1];
          if (nextChar === effectiveDelimiter && effectiveDelimiter === "\n") {
            // Backslash-newline is a line continuation: consume both, don't count as a char
            // Continue reading from the next line
            inputPos += 2;
            consumed = inputPos;
            continue;
          }
          if (nextChar === effectiveDelimiter) {
            // Backslash-delimiter (non-newline): counts as one char (the escaped delimiter)
            inputPos += 2;
            charCount++;
            line += nextChar;
            consumed = inputPos;
            continue;
          }
          line += nextChar;
          inputPos += 2;
          charCount++;
          consumed = inputPos;
        } else {
          line += char;
          inputPos++;
          charCount++;
          consumed = inputPos;
        }
      }
      // For -n: success if we read enough characters OR if we hit the delimiter
      // Failure (exit 1) only if EOF reached before nchars and before delimiter
      foundDelimiter = charCount >= nchars || hitDelimiter;
      // Consume from appropriate source
      consumeInput(consumed);
    } else {
      // Read until delimiter, handling line continuation (backslash-newline) if not raw mode
      // Backslash-newline continuation is handled regardless of the delimiter - it's a line continuation feature
      // Backslash-delimiter escapes the delimiter, making it literal
      consumed = 0;
      let inputPos = 0;
      foundDelimiter = false;

      while (true) {
        if (inputPos >= source.pending.length) {
          if (await source.pull()) continue;
          break;
        }
        const char = source.pending[inputPos];

        // Check for delimiter
        if (char === effectiveDelimiter) {
          consumed = inputPos + effectiveDelimiter.length;
          foundDelimiter = true;
          break;
        }

        if (
          !raw &&
          char === "\\" &&
          inputPos + 1 >= source.pending.length &&
          (await source.pull())
        ) {
          // The escaped character may be in the next chunk.
          continue;
        }

        // In non-raw mode, handle backslash escapes
        if (!raw && char === "\\" && inputPos + 1 < source.pending.length) {
          const nextChar = source.pending[inputPos + 1];

          if (nextChar === "\n") {
            // Backslash-newline is line continuation: skip both, regardless of delimiter
            inputPos += 2;
            continue;
          }

          if (nextChar === effectiveDelimiter) {
            // Backslash-delimiter: escape the delimiter, include it literally
            line += nextChar;
            inputPos += 2;
            continue;
          }

          // Other backslash escapes: keep both for now (will be processed later)
          line += char;
          line += nextChar;
          inputPos += 2;
          continue;
        }

        line += char;
        inputPos++;
      }

      if (!foundDelimiter) {
        // We reached end of input without finding the delimiter
        consumed = inputPos;
        // Check if we got any content
        if (line.length === 0 && source.pending.length === 0) {
          // No input at all - return failure
          for (const name of varNames) {
            envSet(ctx.state.env, name, "");
          }
          if (arrayName) {
            clearArray(ctx, arrayName);
          }
          return result(EMPTY, EMPTY, 1);
        }
      }

      // Consume from appropriate source
      consumeInput(consumed);
    }

    // Remove trailing newline if present and delimiter is newline
    if (effectiveDelimiter === "\n" && line.endsWith("\n")) {
      line = line.slice(0, -1);
    }

    // Helper to process backslash escapes (remove backslashes, keep escaped chars)
    const processBackslashEscapes = (s: string): string => {
      if (raw) return s;
      return s.replace(/\\(.)/g, "$1");
    };

    // If no variable names given (only REPLY), store whole line without IFS splitting
    // This preserves leading/trailing whitespace
    if (varNames.length === 1 && varNames[0] === "REPLY") {
      envSet(ctx.state.env, "REPLY", processBackslashEscapes(line));
      return result(EMPTY, EMPTY, foundDelimiter ? 0 : 1);
    }

    // Split by IFS (default is space, tab, newline)
    const ifs = getIfs(ctx.state.env);

    // Handle array assignment (-a)
    if (arrayName) {
      // Pass raw flag - splitting respects backslash escapes in non-raw mode
      const { words } = splitByIfsForRead(line, ifs, undefined, raw);

      // Check array element limit
      const maxArrayElements = ctx.limits?.maxArrayElements ?? 100000;
      if (words.length > maxArrayElements) {
        return result(
          EMPTY,
          encode(`read: array element limit exceeded (${maxArrayElements})\n`),
          1,
        );
      }

      clearArray(ctx, arrayName);
      // Assign words to array elements, processing backslash escapes after splitting
      for (let j = 0; j < words.length; j++) {
        envSet(
          ctx.state.env,
          `${arrayName}_${j}`,
          processBackslashEscapes(words[j]),
        );
      }
      return result(EMPTY, EMPTY, foundDelimiter ? 0 : 1);
    }

    // Use the advanced IFS splitting for read with proper whitespace/non-whitespace handling
    // Pass raw flag - splitting respects backslash escapes in non-raw mode
    const maxSplit = varNames.length;
    const { words, wordStarts } = splitByIfsForRead(line, ifs, maxSplit, raw);

    // Assign words to variables
    for (let j = 0; j < varNames.length; j++) {
      const name = varNames[j];
      if (j < varNames.length - 1) {
        // Assign single word, processing backslash escapes
        envSet(ctx.state.env, name, processBackslashEscapes(words[j] ?? ""));
      } else {
        // Last variable gets all remaining content from original line
        // This preserves original separators (tabs, etc.) but strips trailing IFS
        if (j < wordStarts.length) {
          // Strip trailing IFS first (respects backslash escapes), then process backslashes
          let value = line.substring(wordStarts[j]);
          value = stripTrailingIfsWhitespace(value, ifs, raw);
          value = processBackslashEscapes(value);
          envSet(ctx.state.env, name, value);
        } else {
          envSet(ctx.state.env, name, "");
        }
      }
    }

    return result(EMPTY, EMPTY, foundDelimiter ? 0 : 1);
  } finally {
    // A read from the command's own stdin consumes at most what it needs;
    // cancel the rest so lazy sources (files, OPFS handles, pipe producers)
    // are released instead of dangling. Group stdin stays open for the next
    // read; -u fd content is a plain string.
    if (!usingGroupStdin && fileDescriptor < 0) {
      await source.cancelSource();
    }
  }
}
