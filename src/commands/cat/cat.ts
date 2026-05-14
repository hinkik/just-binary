import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { decode, decodeArgs } from "../../utils/bytes.js";
import { readFiles } from "../../utils/file-reader.js";
import {
  type ByteStream,
  emptyStream,
  fromString,
} from "../../utils/stream.js";
import { hasHelpFlag, showHelp } from "../help.js";

const catHelp = {
  name: "cat",
  summary: "concatenate files and print on the standard output",
  usage: "cat [OPTION]... [FILE]...",
  options: [
    "-n, --number           number all output lines",
    "    --help             display this help and exit",
  ],
};

const argDefs = {
  number: { short: "n", long: "number", type: "boolean" as const },
};

export const catCommand: Command = {
  name: "cat",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(catHelp);
    }

    const parsed = parseArgs("cat", a, argDefs);
    if (!parsed.ok) return parsed.error;

    const showLineNumbers = parsed.result.flags.number;
    const files = parsed.result.positional;

    // `cat -n` needs cross-chunk line tracking — keep the buffered path
    // (line-numbered output is generally used on small inputs).
    if (showLineNumbers) {
      const readResult = await readFiles(ctx, files, {
        cmdName: "cat",
        allowStdinMarker: true,
        stopOnError: false,
      });
      let stdout = "";
      let lineNumber = 1;
      for (const { content } of readResult.files) {
        const text = decode(content);
        const r = addLineNumbers(text, lineNumber);
        stdout += r.content;
        lineNumber = r.nextLineNumber;
      }
      return {
        stdout: fromString(stdout),
        stderr: fromString(readResult.stderr),
        exitCode: readResult.exitCode,
      };
    }

    // --- Lazy streaming path: cat returns immediately with a pull-based
    // stream that opens each file as the downstream consumer pulls chunks.
    // Pre-validate files so we can report missing-file errors synchronously.
    const sources: Array<{ name: string; kind: "stdin" | "file" }> = [];
    let stderr = "";
    let exitCode = 0;

    const inputs = files.length === 0 ? ["-"] : files;
    for (const f of inputs) {
      if (f === "-") {
        sources.push({ name: "-", kind: "stdin" });
        continue;
      }
      try {
        const realPath = ctx.fs.resolvePath(ctx.cwd, f);
        await ctx.fs.stat(realPath);
        sources.push({ name: realPath, kind: "file" });
      } catch {
        stderr += `cat: ${f}: No such file or directory\n`;
        exitCode = 1;
      }
    }

    let currentReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let sourceIdx = 0;

    const openNext = async (): Promise<boolean> => {
      while (sourceIdx < sources.length) {
        const src = sources[sourceIdx++];
        const stream =
          src.kind === "stdin" ? ctx.stdin : await ctx.fs.readFile(src.name);
        currentReader = stream.getReader();
        return true;
      }
      return false;
    };

    const stdout: ByteStream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        // Loop until we either enqueue a chunk or close the stream. Empty
        // chunks (rare) are skipped without yielding.
        // biome-ignore lint/correctness/noUnreachable: loop structured to handle end-of-source mid-pull
        while (true) {
          if (currentReader === null) {
            const opened = await openNext();
            if (!opened) {
              controller.close();
              return;
            }
          }
          const reader =
            currentReader as ReadableStreamDefaultReader<Uint8Array>;
          const { done, value } = await reader.read();
          if (done) {
            reader.releaseLock();
            currentReader = null;
            continue;
          }
          if (value && value.length > 0) {
            controller.enqueue(value);
            return;
          }
        }
      },
      cancel() {
        if (currentReader) {
          try {
            currentReader.releaseLock();
          } catch {
            // already released
          }
          currentReader = null;
        }
      },
    });

    return {
      stdout: stderr.length === 0 && exitCode === 0 ? stdout : stdout,
      stderr: stderr.length > 0 ? fromString(stderr) : emptyStream(),
      exitCode,
    };
  },
};

function addLineNumbers(
  content: string,
  startLine: number,
): { content: string; nextLineNumber: number } {
  const lines = content.split("\n");
  // Don't number the trailing empty line if file ends with newline
  const hasTrailingNewline = content.endsWith("\n");
  const linesToNumber = hasTrailingNewline ? lines.slice(0, -1) : lines;

  const numbered = linesToNumber.map((line, i) => {
    const num = String(startLine + i).padStart(6, " ");
    return `${num}\t${line}`;
  });

  return {
    content: numbered.join("\n") + (hasTrailingNewline ? "\n" : ""),
    nextLineNumber: startLine + linesToNumber.length,
  };
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "cat",
  flags: [
    { flag: "-n", type: "boolean" },
    { flag: "-A", type: "boolean" },
    { flag: "-b", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-v", type: "boolean" },
    { flag: "-e", type: "boolean" },
    { flag: "-t", type: "boolean" },
  ],
  stdinType: "text",
  needsFiles: true,
};
