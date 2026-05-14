/**
 * rev - reverse lines characterwise
 *
 * Usage: rev [file ...]
 *
 * Copies the specified files to standard output, reversing the order
 * of characters in every line. If no files are specified, standard
 * input is read.
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { decodeArgs } from "../../utils/bytes.js";
import { collectText, emptyStream, fromString } from "../../utils/stream.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const revHelp = {
  name: "rev",
  summary: "reverse lines characterwise",
  usage: "rev [file ...]",
  description:
    "Copies the specified files to standard output, reversing the order of characters in every line. If no files are specified, standard input is read.",
  examples: [
    "echo 'hello' | rev     # Output: olleh",
    "rev file.txt           # Reverse each line in file",
  ],
};

/**
 * Reverse a string, handling Unicode correctly by using Array.from
 * to split by code points rather than UTF-16 code units.
 */
function reverseString(str: string): string {
  return Array.from(str).reverse().join("");
}

export const rev: Command = {
  name: "rev",
  execute: async (
    args: Uint8Array[],
    ctx: CommandContext,
  ): Promise<ExecResult> => {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(revHelp);
    }

    const files: string[] = [];
    for (const arg of a) {
      if (arg === "--") {
        // Everything after -- is a file
        const idx = a.indexOf(arg);
        files.push(...a.slice(idx + 1));
        break;
      } else if (arg.startsWith("-") && arg !== "-") {
        return unknownOption("rev", arg);
      } else {
        files.push(arg);
      }
    }
    let output = "";

    // Process function for content
    const processContent = (content: string): string => {
      const lines = content.split("\n");
      // Handle trailing newline - if content ends with \n, last element is empty
      const hasTrailingNewline =
        content.endsWith("\n") && lines[lines.length - 1] === "";
      if (hasTrailingNewline) {
        lines.pop();
      }
      const reversed = lines.map(reverseString);
      return reversed.join("\n") + (hasTrailingNewline ? "\n" : "");
    };

    if (files.length === 0) {
      // Read from stdin
      const input = await collectText(ctx.stdin);
      output = processContent(input);
    } else {
      // Process each file
      let stdinText: string | null = null;
      for (const file of files) {
        if (file === "-") {
          // Dash means read from stdin
          if (stdinText === null) stdinText = await collectText(ctx.stdin);
          output += processContent(stdinText);
        } else {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          try {
            const content = await ctx.fs.readFileText(filePath);
            output += processContent(content);
          } catch {
            return {
              exitCode: 1,
              stdout: fromString(output),
              stderr: fromString(`rev: ${file}: No such file or directory\n`),
            };
          }
        }
      }
    }

    return {
      exitCode: 0,
      stdout: fromString(output),
      stderr: emptyStream(),
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "rev",
  flags: [],
  stdinType: "text",
  needsFiles: true,
};
