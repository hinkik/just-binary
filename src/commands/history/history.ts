import type { Command, CommandContext, ExecResult } from "../../types.js";
import {
  decodeArgs,
  EMPTY,
  encode,
  envGet,
  envSet,
} from "../../utils/bytes.js";
import { hasHelpFlag, showHelp } from "../help.js";

const historyHelp = {
  name: "history",
  summary: "display command history",
  usage: "history [n]",
  options: [
    "-c      clear the history list",
    "    --help display this help and exit",
  ],
};

// History is stored in the environment as JSON
const HISTORY_KEY = "BASH_HISTORY";

export const historyCommand: Command = {
  name: "history",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(historyHelp);
    }

    // Get history from environment
    const historyStr = envGet(ctx.env, HISTORY_KEY, "[]");
    let history: string[];
    try {
      history = JSON.parse(historyStr);
    } catch {
      history = [];
    }

    // Handle -c (clear)
    if (a[0] === "-c") {
      envSet(ctx.env, HISTORY_KEY, "[]");
      return { stdout: EMPTY, stderr: EMPTY, exitCode: 0 };
    }

    // Get optional count
    let count = history.length;
    if (a[0] && /^\d+$/.test(a[0])) {
      count = Math.min(parseInt(a[0], 10), history.length);
    }

    // Display history
    const start = history.length - count;
    let stdout = "";
    for (let i = start; i < history.length; i++) {
      const lineNum = (i + 1).toString().padStart(5, " ");
      stdout += `${lineNum}  ${history[i]}\n`;
    }

    return { stdout: encode(stdout), stderr: EMPTY, exitCode: 0 };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "history",
  flags: [{ flag: "-c", type: "boolean" }],
};
