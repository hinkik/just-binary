import { getErrorMessage } from "../../interpreter/helpers/errors.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { decodeArgs, EMPTY, encode } from "../../utils/bytes.js";

const argDefs = {
  recursive: { short: "p", long: "parents", type: "boolean" as const },
  verbose: { short: "v", long: "verbose", type: "boolean" as const },
};

export const mkdirCommand: Command = {
  name: "mkdir",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    const parsed = parseArgs("mkdir", a, argDefs);
    if (!parsed.ok) return parsed.error;

    const recursive = parsed.result.flags.recursive;
    const verbose = parsed.result.flags.verbose;
    const dirs = parsed.result.positional;

    if (dirs.length === 0) {
      return {
        stdout: EMPTY,
        stderr: encode("mkdir: missing operand\n"),
        exitCode: 1,
      };
    }

    let stdout = "";
    let stderr = "";
    let exitCode = 0;

    for (const dir of dirs) {
      try {
        const fullPath = ctx.fs.resolvePath(ctx.cwd, dir);
        await ctx.fs.mkdir(fullPath, { recursive });
        if (verbose) {
          stdout += `mkdir: created directory '${dir}'\n`;
        }
      } catch (error) {
        const message = getErrorMessage(error);
        if (message.includes("ENOENT") || message.includes("no such file")) {
          stderr += `mkdir: cannot create directory '${dir}': No such file or directory\n`;
        } else if (
          message.includes("EEXIST") ||
          message.includes("already exists")
        ) {
          stderr += `mkdir: cannot create directory '${dir}': File exists\n`;
        } else {
          stderr += `mkdir: cannot create directory '${dir}': ${message}\n`;
        }
        exitCode = 1;
      }
    }

    return { stdout: encode(stdout), stderr: encode(stderr), exitCode };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "mkdir",
  flags: [
    { flag: "-p", type: "boolean" },
    { flag: "-v", type: "boolean" },
  ],
  needsArgs: true,
};
