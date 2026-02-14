import type { Command, CommandContext, ExecResult } from "../../types.js";
import { decode, decodeArgs, EMPTY, encode } from "../../utils/bytes.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";

const envHelp = {
  name: "env",
  summary: "run a program in a modified environment",
  usage: "env [OPTION]... [NAME=VALUE]... [COMMAND [ARG]...]",
  options: [
    "-i, --ignore-environment  start with an empty environment",
    "-u NAME, --unset=NAME     remove NAME from the environment",
    "    --help                display this help and exit",
  ],
};

export const envCommand: Command = {
  name: "env",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(envHelp);
    }

    let ignoreEnv = false;
    const unsetVars: string[] = [];
    const setVars = new Map<string, string>();
    let commandStart = -1;

    // Parse arguments
    for (let i = 0; i < a.length; i++) {
      const arg = a[i];

      if (arg === "-i" || arg === "--ignore-environment") {
        ignoreEnv = true;
      } else if (arg === "-u" && i + 1 < a.length) {
        unsetVars.push(a[++i]);
      } else if (arg.startsWith("-u")) {
        unsetVars.push(arg.slice(2));
      } else if (arg.startsWith("--unset=")) {
        unsetVars.push(arg.slice(8));
      } else if (arg.startsWith("--") && arg !== "--") {
        return unknownOption("env", arg);
      } else if (arg.startsWith("-") && arg !== "-") {
        // Check for unknown single-char options
        for (const c of arg.slice(1)) {
          if (c !== "i" && c !== "u") {
            return unknownOption("env", `-${c}`);
          }
        }
        if (arg.includes("i")) ignoreEnv = true;
      } else if (arg.includes("=") && commandStart === -1) {
        // NAME=VALUE assignment
        const eqIdx = arg.indexOf("=");
        const name = arg.slice(0, eqIdx);
        const value = arg.slice(eqIdx + 1);
        setVars.set(name, value);
      } else {
        // Start of command
        commandStart = i;
        break;
      }
    }

    // Build the new environment
    // ctx.env is Map<string, Uint8Array>, but we work with strings for env command
    let newEnvLines: [string, string][];
    if (ignoreEnv) {
      newEnvLines = [...setVars.entries()];
    } else {
      // Decode all env values to strings
      const decoded: [string, string][] = [];
      for (const [key, val] of ctx.env) {
        decoded.push([key, decode(val)]);
      }
      // Apply unsets
      const filtered = decoded.filter(([k]) => !unsetVars.includes(k));
      // Build map for overrides
      const envMap = new Map(filtered);
      for (const [name, value] of setVars) {
        envMap.set(name, value);
      }
      newEnvLines = [...envMap.entries()];
    }

    // If no command, just print environment
    if (commandStart === -1) {
      const lines: string[] = [];
      for (const [key, value] of newEnvLines) {
        lines.push(`${key}=${value}`);
      }
      return {
        stdout: encode(lines.join("\n") + (lines.length > 0 ? "\n" : "")),
        stderr: EMPTY,
        exitCode: 0,
      };
    }

    // Execute command with modified environment
    if (!ctx.exec) {
      return {
        stdout: EMPTY,
        stderr: encode(
          "env: command execution not supported in this context\n",
        ),
        exitCode: 1,
      };
    }

    // Build command line
    // Use 'command' prefix to bypass shell keywords (like 'time')
    // This ensures we run the actual command, not the shell keyword
    const cmdArgs = a.slice(commandStart);
    const cmdName = cmdArgs[0];
    const cmdRest = cmdArgs.slice(1);

    // Quote arguments that contain spaces or special characters
    const quotedArgs = cmdRest.map((arg) => {
      if (/[\s"'\\$`!*?[\]{}|&;<>()]/.test(arg)) {
        // Use single quotes, escaping existing single quotes
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    });

    const command = [`command`, cmdName, ...quotedArgs].join(" ");

    // Create a modified context and execute
    // Note: We can't directly modify the context for exec, so we pass the env vars as prefix
    // This is a limitation - in a real implementation, exec would accept an env parameter
    const envPrefix = [...setVars.entries()]
      .map(([k, v]) => `${k}="${v}"`)
      .join(" ");

    const fullCommand = envPrefix ? `${envPrefix} ${command}` : command;
    return ctx.exec(fullCommand, { cwd: ctx.cwd });
  },
};

const printenvHelp = {
  name: "printenv",
  summary: "print all or part of environment",
  usage: "printenv [OPTION]... [VARIABLE]...",
  options: ["    --help       display this help and exit"],
};

export const printenvCommand: Command = {
  name: "printenv",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(printenvHelp);
    }

    const vars = a.filter((arg) => !arg.startsWith("-"));

    if (vars.length === 0) {
      // Print all
      const lines: string[] = [];
      for (const [key, val] of ctx.env) {
        lines.push(`${key}=${decode(val)}`);
      }
      return {
        stdout: encode(lines.join("\n") + (lines.length > 0 ? "\n" : "")),
        stderr: EMPTY,
        exitCode: 0,
      };
    }

    // Print specific variables
    const lines: string[] = [];
    let exitCode = 0;
    for (const varName of vars) {
      const value = ctx.env.get(varName);
      if (value !== undefined) {
        lines.push(decode(value));
      } else {
        exitCode = 1;
      }
    }

    return {
      stdout: encode(lines.join("\n") + (lines.length > 0 ? "\n" : "")),
      stderr: EMPTY,
      exitCode,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "env",
  flags: [
    { flag: "-i", type: "boolean" },
    { flag: "-u", type: "value", valueHint: "string" },
  ],
};

export const printenvFlagsForFuzzing: CommandFuzzInfo = {
  name: "printenv",
  flags: [],
};
