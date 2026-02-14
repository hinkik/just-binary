import type { Command, CommandContext, ExecResult } from "../../types.js";
import {
  decodeArgs,
  EMPTY,
  encode,
  envGet,
  envSet,
} from "../../utils/bytes.js";
import { hasHelpFlag, showHelp } from "../help.js";

const aliasHelp = {
  name: "alias",
  summary: "define or display aliases",
  usage: "alias [name[=value] ...]",
  options: ["    --help display this help and exit"],
};

// Aliases are stored in the environment
// Format: BASH_ALIASES_<name>=<value>
const ALIAS_PREFIX = "BASH_ALIAS_";

export const aliasCommand: Command = {
  name: "alias",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(aliasHelp);
    }

    // No arguments: list all aliases
    if (a.length === 0) {
      let stdout = "";
      for (const key of ctx.env.keys()) {
        if (key.startsWith(ALIAS_PREFIX)) {
          const name = key.slice(ALIAS_PREFIX.length);
          stdout += `alias ${name}='${envGet(ctx.env, key)}'\n`;
        }
      }
      return { stdout: encode(stdout), stderr: EMPTY, exitCode: 0 };
    }

    // Process alias definitions
    // Skip "--" option separator (POSIX standard)
    const processArgs = a[0] === "--" ? a.slice(1) : a;
    for (const arg of processArgs) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx === -1) {
        // Show single alias
        const key = ALIAS_PREFIX + arg;
        if (ctx.env.get(key)) {
          return {
            stdout: encode(`alias ${arg}='${envGet(ctx.env, key)}'\n`),
            stderr: EMPTY,
            exitCode: 0,
          };
        } else {
          return {
            stdout: EMPTY,
            stderr: encode(`alias: ${arg}: not found\n`),
            exitCode: 1,
          };
        }
      } else {
        // Set alias
        const name = arg.slice(0, eqIdx);
        let value = arg.slice(eqIdx + 1);
        // Remove quotes if present
        if (
          (value.startsWith("'") && value.endsWith("'")) ||
          (value.startsWith('"') && value.endsWith('"'))
        ) {
          value = value.slice(1, -1);
        }
        envSet(ctx.env, ALIAS_PREFIX + name, value);
      }
    }

    return { stdout: EMPTY, stderr: EMPTY, exitCode: 0 };
  },
};

export const unaliasCommand: Command = {
  name: "unalias",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp({
        name: "unalias",
        summary: "remove alias definitions",
        usage: "unalias name [name ...]",
        options: [
          "-a      remove all aliases",
          "    --help display this help and exit",
        ],
      });
    }

    if (a.length === 0) {
      return {
        stdout: EMPTY,
        stderr: encode("unalias: usage: unalias [-a] name [name ...]\n"),
        exitCode: 1,
      };
    }

    // Handle -a to remove all aliases
    if (a[0] === "-a") {
      for (const key of ctx.env.keys()) {
        if (key.startsWith(ALIAS_PREFIX)) {
          ctx.env.delete(key);
        }
      }
      return { stdout: EMPTY, stderr: EMPTY, exitCode: 0 };
    }

    // Skip "--" option separator (POSIX standard)
    const processArgs = a[0] === "--" ? a.slice(1) : a;

    let anyError = false;
    let stderr = "";
    for (const name of processArgs) {
      const key = ALIAS_PREFIX + name;
      if (ctx.env.get(key)) {
        ctx.env.delete(key);
      } else {
        stderr += `unalias: ${name}: not found\n`;
        anyError = true;
      }
    }

    return {
      stdout: EMPTY,
      stderr: encode(stderr),
      exitCode: anyError ? 1 : 0,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "alias",
  flags: [],
};

export const unaliasFlagsForFuzzing: CommandFuzzInfo = {
  name: "unalias",
  flags: [{ flag: "-a", type: "boolean" }],
};
