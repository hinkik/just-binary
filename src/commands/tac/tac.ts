/**
 * tac - concatenate and print files in reverse
 *
 * Usage: tac [OPTION]... [FILE]...
 *
 * Writes each FILE to standard output, last line first.
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { decodeArgs } from "../../utils/bytes.js";
import { collectText, emptyStream, fromString } from "../../utils/stream.js";

async function tacExecute(
  args: Uint8Array[],
  ctx: CommandContext,
): Promise<ExecResult> {
  const a = decodeArgs(args);
  // For now, just handle stdin (no file support)
  // TODO: Add file support
  if (a.length > 0 && a[0] !== "-") {
    // Try to read from file
    const filePath = a[0].startsWith("/") ? a[0] : `${ctx.cwd}/${a[0]}`;
    try {
      const content = await ctx.fs.readFileText(filePath);
      const lines = content.split("\n");
      if (lines[lines.length - 1] === "") {
        lines.pop();
      }
      const reversed = lines.reverse();
      return {
        stdout: fromString(
          reversed.length > 0 ? `${reversed.join("\n")}\n` : "",
        ),
        stderr: emptyStream(),
        exitCode: 0,
      };
    } catch {
      return {
        stdout: emptyStream(),
        stderr: fromString(`tac: ${a[0]}: No such file or directory\n`),
        exitCode: 1,
      };
    }
  }

  // Read from stdin
  const text = await collectText(ctx.stdin);
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  const reversed = lines.reverse();
  return {
    stdout: fromString(reversed.length > 0 ? `${reversed.join("\n")}\n` : ""),
    stderr: emptyStream(),
    exitCode: 0,
  };
}

export const tac: Command = {
  name: "tac",
  execute: tacExecute,
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "tac",
  flags: [],
  stdinType: "text",
  needsFiles: true,
};
