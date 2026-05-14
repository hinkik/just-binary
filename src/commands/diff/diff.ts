/**
 * diff - Compare files line by line
 */

import * as Diff from "diff";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { decode, decodeArgs } from "../../utils/bytes.js";
import { hasHelpFlag, showHelp } from "../help.js";

const diffHelp = {
  name: "diff",
  summary: "compare files line by line",
  usage: "diff [OPTION]... FILE1 FILE2",
  options: [
    "-u, --unified     output unified diff format (default)",
    "-q, --brief       report only whether files differ",
    "-s, --report-identical-files  report when files are the same",
    "-i, --ignore-case  ignore case differences",
    "    --help        display this help and exit",
  ],
};

const argDefs = {
  unified: { short: "u", long: "unified", type: "boolean" as const },
  brief: { short: "q", long: "brief", type: "boolean" as const },
  reportSame: {
    short: "s",
    long: "report-identical-files",
    type: "boolean" as const,
  },
  ignoreCase: { short: "i", long: "ignore-case", type: "boolean" as const },
};

export const diffCommand: Command = {
  name: "diff",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) return showHelp(diffHelp);

    const parsed = parseArgs("diff", a, argDefs);
    if (!parsed.ok) return parsed.error;

    const brief = parsed.result.flags.brief;
    const reportSame = parsed.result.flags.reportSame;
    const ignoreCase = parsed.result.flags.ignoreCase;
    const files = parsed.result.positional;

    // Note: unified flag is accepted but is the default behavior
    void parsed.result.flags.unified;

    if (files.length < 2) {
      return {
        stdout: emptyStream(),
        stderr: fromString("diff: missing operand\n"),
        exitCode: 2,
      };
    }

    let b1: Uint8Array, b2: Uint8Array;
    const [f1, f2] = files;
    let stdinBytes: Uint8Array | null = null;
    const getStdin = async (): Promise<Uint8Array> => {
      if (stdinBytes === null) stdinBytes = await collectBytes(ctx.stdin);
      return stdinBytes;
    };

    try {
      b1 =
        f1 === "-"
          ? await getStdin()
          : await collectBytes(
              await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f1)),
            );
    } catch {
      return {
        stdout: emptyStream(),
        stderr: fromString(`diff: ${f1}: No such file or directory\n`),
        exitCode: 2,
      };
    }

    try {
      b2 =
        f2 === "-"
          ? await getStdin()
          : await collectBytes(
              await ctx.fs.readFile(ctx.fs.resolvePath(ctx.cwd, f2)),
            );
    } catch {
      return {
        stdout: emptyStream(),
        stderr: fromString(`diff: ${f2}: No such file or directory\n`),
        exitCode: 2,
      };
    }

    // Compare raw bytes to avoid UTF-8 decode masking binary differences
    const bytesEqual =
      b1.length === b2.length && b1.every((v, i) => v === b2[i]);

    const c1 = decode(b1);
    const c2 = decode(b2);

    let identical = bytesEqual;
    if (!identical && ignoreCase) {
      identical = c1.toLowerCase() === c2.toLowerCase();
    }

    if (identical) {
      if (reportSame)
        return {
          stdout: fromString(`Files ${f1} and ${f2} are identical\n`),
          stderr: emptyStream(),
          exitCode: 0,
        };
      return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 0 };
    }

    if (brief) {
      return {
        stdout: fromString(`Files ${f1} and ${f2} differ\n`),
        stderr: emptyStream(),
        exitCode: 1,
      };
    }

    const output = Diff.createTwoFilesPatch(f1, f2, c1, c2, "", "", {
      context: 3,
    });
    return { stdout: fromString(output), stderr: emptyStream(), exitCode: 1 };
  },
};

import { collectBytes, emptyStream, fromString } from "../../utils/stream.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "diff",
  flags: [
    { flag: "-u", type: "boolean" },
    { flag: "-q", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-i", type: "boolean" },
  ],
  needsArgs: true,
  minArgs: 2,
};
