import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { decodeArgs } from "../../utils/bytes.js";
import {
  type ByteStream,
  emptyStream,
  fromString,
  streamLines,
} from "../../utils/stream.js";
import { hasHelpFlag, showHelp } from "../help.js";

const uniqHelp = {
  name: "uniq",
  summary: "report or omit repeated lines",
  usage: "uniq [OPTION]... [INPUT [OUTPUT]]",
  options: [
    "-c, --count        prefix lines by the number of occurrences",
    "-d, --repeated     only print duplicate lines",
    "-i, --ignore-case  ignore case when comparing",
    "-u, --unique       only print unique lines",
    "    --help         display this help and exit",
  ],
};

const argDefs = {
  count: { short: "c", long: "count", type: "boolean" as const },
  duplicatesOnly: { short: "d", long: "repeated", type: "boolean" as const },
  uniqueOnly: { short: "u", long: "unique", type: "boolean" as const },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" as const },
};

export const uniqCommand: Command = {
  name: "uniq",
  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(uniqHelp);
    }

    const parsed = parseArgs("uniq", a, argDefs);
    if (!parsed.ok) return parsed.error;

    const { count, duplicatesOnly, uniqueOnly, ignoreCase } =
      parsed.result.flags;
    const files = parsed.result.positional;

    // Resolve input stream — file or stdin.
    let input: ByteStream;
    const openError = "";
    if (files.length === 0) {
      input = ctx.stdin;
    } else {
      const file = files[0];
      if (file === "-") {
        input = ctx.stdin;
      } else {
        try {
          input = await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
        } catch {
          return {
            stdout: emptyStream(),
            stderr: fromString(`uniq: ${file}: No such file or directory\n`),
            exitCode: 1,
          };
        }
      }
    }

    // Stream lines. Track current line + run count, emit groups as they
    // close. Memory is bounded by the longest run of identical adjacent
    // lines (typically a single line).
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const formatOut = (line: string, c: number): string => {
      if (duplicatesOnly && c <= 1) return "";
      if (uniqueOnly && c !== 1) return "";
      return count ? `${String(c).padStart(4)} ${line}\n` : `${line}\n`;
    };

    const keyOf = (s: string) => (ignoreCase ? s.toLowerCase() : s);

    // Pull-based: a single async generator iterates lines and yields output
    // lazily. Cancellation propagates back into the streamLines reader.
    let lineIter: AsyncIterator<Uint8Array> | null = null;
    let currentLine: string | null = null;
    let currentKey = "";
    let currentCount = 0;
    let flushed = false;
    const stream: ByteStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (lineIter === null) {
          lineIter = streamLines(input)[Symbol.asyncIterator]();
        }
        while (true) {
          const { done, value } = await lineIter.next();
          if (done) {
            if (!flushed && currentLine !== null) {
              flushed = true;
              const out = formatOut(currentLine, currentCount);
              if (out.length > 0) {
                controller.enqueue(encoder.encode(out) as Uint8Array);
                return;
              }
            }
            controller.close();
            return;
          }
          const line = decoder.decode(value);
          const key = keyOf(line);
          if (currentLine === null) {
            currentLine = line;
            currentKey = key;
            currentCount = 1;
            continue;
          }
          if (key === currentKey) {
            currentCount++;
            continue;
          }
          const out = formatOut(currentLine, currentCount);
          currentLine = line;
          currentKey = key;
          currentCount = 1;
          if (out.length > 0) {
            controller.enqueue(encoder.encode(out) as Uint8Array);
            return;
          }
        }
      },
      async cancel() {
        if (lineIter?.return) {
          try {
            await lineIter.return();
          } catch {
            // ignore
          }
        }
      },
    });

    return {
      stdout: stream,
      stderr: openError.length > 0 ? fromString(openError) : emptyStream(),
      exitCode: 0,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "uniq",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-d", type: "boolean" },
    { flag: "-u", type: "boolean" },
    { flag: "-i", type: "boolean" },
  ],
  stdinType: "text",
  needsFiles: true,
};
