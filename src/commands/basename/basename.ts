import type { Command, CommandContext, ExecResult } from "../../types.js";
import { decodeArgs, EMPTY, encode } from "../../utils/bytes.js";
import { hasHelpFlag, showHelp } from "../help.js";

const basenameHelp = {
  name: "basename",
  summary: "strip directory and suffix from filenames",
  usage: "basename NAME [SUFFIX]\nbasename OPTION... NAME...",
  options: [
    "-a, --multiple   support multiple arguments",
    "-s, --suffix=SUFFIX  remove a trailing SUFFIX",
    "    --help       display this help and exit",
  ],
};

export const basenameCommand: Command = {
  name: "basename",

  async execute(args: Uint8Array[], _ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(basenameHelp);
    }

    let multiple = false;
    let suffix = "";
    const names: string[] = [];

    for (let i = 0; i < a.length; i++) {
      const arg = a[i];
      if (arg === "-a" || arg === "--multiple") {
        multiple = true;
      } else if (arg === "-s" && i + 1 < a.length) {
        suffix = a[++i];
        multiple = true;
      } else if (arg.startsWith("--suffix=")) {
        suffix = arg.slice(9);
        multiple = true;
      } else if (!arg.startsWith("-")) {
        names.push(arg);
      }
    }

    if (names.length === 0) {
      return {
        stdout: EMPTY,
        stderr: encode("basename: missing operand\n"),
        exitCode: 1,
      };
    }

    // If not multiple mode, second arg is suffix
    if (!multiple && names.length >= 2) {
      suffix = names.pop() ?? "";
    }

    const results: string[] = [];
    for (const name of names) {
      // Remove trailing slashes
      const cleanName = name.replace(/\/+$/, "");
      let base = cleanName.split("/").pop() || cleanName;
      if (suffix && base.endsWith(suffix)) {
        base = base.slice(0, -suffix.length);
      }
      results.push(base);
    }

    return {
      stdout: encode(`${results.join("\n")}\n`),
      stderr: EMPTY,
      exitCode: 0,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "basename",
  flags: [
    { flag: "-a", type: "boolean" },
    { flag: "-s", type: "value", valueHint: "string" },
  ],
  needsArgs: true,
};
