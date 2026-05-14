import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { decodeArgs } from "../../utils/bytes.js";
import { streamChunks } from "../../utils/stream.js";
import { hasHelpFlag, showHelp } from "../help.js";

const wcHelp = {
  name: "wc",
  summary: "print newline, word, and byte counts for each file",
  usage: "wc [OPTION]... [FILE]...",
  options: [
    "-c, --bytes      print the byte counts",
    "-m, --chars      print the character counts",
    "-l, --lines      print the newline counts",
    "-w, --words      print the word counts",
    "    --help       display this help and exit",
  ],
};

const argDefs = {
  lines: { short: "l", long: "lines", type: "boolean" as const },
  words: { short: "w", long: "words", type: "boolean" as const },
  bytes: { short: "c", long: "bytes", type: "boolean" as const },
  chars: { short: "m", long: "chars", type: "boolean" as const },
};

export const wcCommand: Command = {
  name: "wc",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(wcHelp);
    }

    const parsed = parseArgs("wc", a, argDefs);
    if (!parsed.ok) return parsed.error;

    let { lines: showLines, words: showWords } = parsed.result.flags;
    // -c (bytes) and -m (chars) both show character counts
    let showChars = parsed.result.flags.bytes || parsed.result.flags.chars;
    const files = parsed.result.positional;

    // If no flags specified, show all
    if (!showLines && !showWords && !showChars) {
      showLines = showWords = showChars = true;
    }

    // No files → count from stdin stream
    if (files.length === 0) {
      const stats = await countStatsFromStream(ctx.stdin);
      return {
        stdout: fromString(
          `${formatStats(stats, showLines, showWords, showChars, "", 0)}\n`,
        ),
        stderr: emptyStream(),
        exitCode: 0,
      };
    }

    // Count each file's stats by streaming its contents — never materialize
    // the full file as a string or single Uint8Array.
    const allStats: Array<{
      filename: string;
      stats: { lines: number; words: number; chars: number };
    }> = [];
    let totalLines = 0;
    let totalWords = 0;
    let totalChars = 0;
    let readStderr = "";
    let readExit = 0;

    for (const file of files) {
      try {
        const stream =
          file === "-"
            ? ctx.stdin
            : await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, file));
        const stats = await countStatsFromStream(stream);
        totalLines += stats.lines;
        totalWords += stats.words;
        totalChars += stats.chars;
        allStats.push({ filename: file, stats });
      } catch {
        readStderr += `wc: ${file}: No such file or directory\n`;
        readExit = 1;
      }
    }

    // Calculate the max width needed for alignment
    // Consider totals if we have multiple files
    const maxLines =
      files.length > 1
        ? totalLines
        : Math.max(...allStats.map((s) => s.stats.lines));
    const maxWords =
      files.length > 1
        ? totalWords
        : Math.max(...allStats.map((s) => s.stats.words));
    const maxChars =
      files.length > 1
        ? totalChars
        : Math.max(...allStats.map((s) => s.stats.chars));

    // Calculate width based on which columns are shown
    // Use minimum width of 3 for alignment when there are multiple files (matches osh behavior)
    let maxWidth = files.length > 1 ? 3 : 0;
    if (showLines) maxWidth = Math.max(maxWidth, String(maxLines).length);
    if (showWords) maxWidth = Math.max(maxWidth, String(maxWords).length);
    if (showChars) maxWidth = Math.max(maxWidth, String(maxChars).length);

    // Second pass: format output with proper alignment
    let stdout = "";
    for (const { filename, stats } of allStats) {
      stdout += `${formatStats(stats, showLines, showWords, showChars, filename, maxWidth)}\n`;
    }

    // Show total for multiple files
    if (files.length > 1) {
      stdout += `${formatStats(
        { lines: totalLines, words: totalWords, chars: totalChars },
        showLines,
        showWords,
        showChars,
        "total",
        maxWidth,
      )}\n`;
    }

    return {
      stdout: fromString(stdout),
      stderr: fromString(readStderr),
      exitCode: readExit,
    };
  },
};

/**
 * Stream-count lines, words and bytes. Counts whitespace at the byte level —
 * exactly what real `wc` does for ASCII; multi-byte UTF-8 sequences contribute
 * each byte to the char count, matching `wc -c`. (`wc -m` would need code-point
 * counting; we currently report bytes for `-m` too — same as before this refactor.)
 */
async function countStatsFromStream(
  stream: import("../../utils/stream.js").ByteStream,
): Promise<{ lines: number; words: number; chars: number }> {
  let lines = 0;
  let words = 0;
  let chars = 0;
  let inWord = false;

  for await (const chunk of streamChunks(stream)) {
    chars += chunk.length;
    const len = chunk.length;
    for (let i = 0; i < len; i++) {
      const c = chunk[i];
      if (c === 0x0a /* \n */) {
        lines++;
        if (inWord) {
          words++;
          inWord = false;
        }
      } else if (
        c === 0x20 /* space */ ||
        c === 0x09 /* tab */ ||
        c === 0x0d /* CR */
      ) {
        if (inWord) {
          words++;
          inWord = false;
        }
      } else {
        inWord = true;
      }
    }
  }
  if (inWord) words++;
  return { lines, words, chars };
}

function formatStats(
  stats: { lines: number; words: number; chars: number },
  showLines: boolean,
  showWords: boolean,
  showChars: boolean,
  filename: string,
  minWidth: number,
): string {
  const values: string[] = [];
  if (showLines) {
    values.push(String(stats.lines).padStart(minWidth));
  }
  if (showWords) {
    values.push(String(stats.words).padStart(minWidth));
  }
  if (showChars) {
    values.push(String(stats.chars).padStart(minWidth));
  }

  let result = values.join(" ");
  if (filename) {
    result += ` ${filename}`;
  }

  return result;
}

import { emptyStream, fromString } from "../../utils/stream.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "wc",
  flags: [
    { flag: "-l", type: "boolean" },
    { flag: "-w", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-m", type: "boolean" },
  ],
  stdinType: "text",
  needsFiles: true,
};
