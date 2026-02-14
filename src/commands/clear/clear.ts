import type { Command, CommandContext, ExecResult } from "../../types.js";
import { decodeArgs, EMPTY, encode } from "../../utils/bytes.js";
import { hasHelpFlag, showHelp } from "../help.js";

const clearHelp = {
  name: "clear",
  summary: "clear the terminal screen",
  usage: "clear [OPTIONS]",
  options: ["    --help display this help and exit"],
};

export const clearCommand: Command = {
  name: "clear",

  async execute(args: Uint8Array[], _ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(clearHelp);
    }

    // ANSI escape sequence to clear screen and move cursor to top-left
    const clearSequence = "\x1B[2J\x1B[H";

    return { stdout: encode(clearSequence), stderr: EMPTY, exitCode: 0 };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "clear",
  flags: [],
};
