/**
 * getopts - Parse positional parameters as options
 *
 * getopts optstring name [arg...]
 *
 * Parses options from positional parameters (or provided args).
 * - optstring: string of valid option characters
 * - If a character is followed by ':', it requires an argument
 * - If optstring starts with ':', silent error reporting mode
 * - name: variable to store the current option
 * - OPTARG: set to the option argument (if any)
 * - OPTIND: index of next argument to process (starts at 1)
 *
 * Returns 0 if option found, 1 if end of options or error.
 */

import type { ExecResult } from "../../types.js";
import { EMPTY, encode, envGet, envSet } from "../../utils/bytes.js";
import { failure } from "../helpers/result.js";
import type { InterpreterContext } from "../types.js";

export function handleGetopts(
  ctx: InterpreterContext,
  args: string[],
): ExecResult {
  // Need at least optstring and name
  if (args.length < 2) {
    return failure("bash: getopts: usage: getopts optstring name [arg ...]\n");
  }

  const optstring = args[0];
  const varName = args[1];

  // Check if variable name is valid (must be a valid identifier)
  const invalidVarName = !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(varName);

  // Determine if silent mode (optstring starts with ':')
  const silentMode = optstring.startsWith(":");
  const actualOptstring = silentMode ? optstring.slice(1) : optstring;

  // Get arguments to parse - either explicit args or positional parameters
  let argsToProcess: string[];
  if (args.length > 2) {
    // Explicit arguments provided
    argsToProcess = args.slice(2);
  } else {
    // Use positional parameters
    const paramCount = Number.parseInt(envGet(ctx.state.env, "#", "0"), 10);
    argsToProcess = [];
    for (let i = 1; i <= paramCount; i++) {
      argsToProcess.push(envGet(ctx.state.env, String(i)) || "");
    }
  }

  // Get current OPTIND (1-based, default 1)
  let optind = Number.parseInt(envGet(ctx.state.env, "OPTIND", "1"), 10);
  if (optind < 1) {
    optind = 1;
  }

  // Get the "char index" within the current argument for combined options like -abc
  // We store this in a special internal variable
  const charIndex = Number.parseInt(
    envGet(ctx.state.env, "__GETOPTS_CHARINDEX", "0"),
    10,
  );

  // Clear OPTARG
  envSet(ctx.state.env, "OPTARG", "");

  // Check if we've exhausted all arguments
  if (optind > argsToProcess.length) {
    if (!invalidVarName) {
      envSet(ctx.state.env, varName, "?");
    }
    // When returning because OPTIND is past all args, bash sets OPTIND to args.length + 1
    envSet(ctx.state.env, "OPTIND", String(argsToProcess.length + 1));
    envSet(ctx.state.env, "__GETOPTS_CHARINDEX", "0");
    return { exitCode: invalidVarName ? 2 : 1, stdout: EMPTY, stderr: EMPTY };
  }

  // Get current argument (0-indexed in array, but OPTIND is 1-based)
  const currentArg = argsToProcess[optind - 1];

  // Check if this is an option argument (starts with -)
  if (!currentArg || currentArg === "-" || !currentArg.startsWith("-")) {
    // Not an option - end of options
    if (!invalidVarName) {
      envSet(ctx.state.env, varName, "?");
    }
    return { exitCode: invalidVarName ? 2 : 1, stdout: EMPTY, stderr: EMPTY };
  }

  // Check for -- (end of options marker)
  if (currentArg === "--") {
    envSet(ctx.state.env, "OPTIND", String(optind + 1));
    envSet(ctx.state.env, "__GETOPTS_CHARINDEX", "0");
    if (!invalidVarName) {
      envSet(ctx.state.env, varName, "?");
    }
    return { exitCode: invalidVarName ? 2 : 1, stdout: EMPTY, stderr: EMPTY };
  }

  // Get the option character to process
  // charIndex 0 means we're starting a new argument, so skip the leading '-'
  const startIndex = charIndex === 0 ? 1 : charIndex;
  const optChar = currentArg[startIndex];

  if (!optChar) {
    // No more characters in this argument, move to next
    envSet(ctx.state.env, "OPTIND", String(optind + 1));
    envSet(ctx.state.env, "__GETOPTS_CHARINDEX", "0");
    // Recursively call to process next argument
    return handleGetopts(ctx, args);
  }

  // Check if this option is valid
  const optIndex = actualOptstring.indexOf(optChar);
  if (optIndex === -1) {
    // Invalid option
    let stderrMsg = "";
    if (!silentMode) {
      stderrMsg = `bash: illegal option -- ${optChar}\n`;
    } else {
      envSet(ctx.state.env, "OPTARG", optChar);
    }
    if (!invalidVarName) {
      envSet(ctx.state.env, varName, "?");
    }

    // Move to next character or next argument
    if (startIndex + 1 < currentArg.length) {
      envSet(ctx.state.env, "__GETOPTS_CHARINDEX", String(startIndex + 1));
      envSet(ctx.state.env, "OPTIND", String(optind)); // Always set OPTIND
    } else {
      envSet(ctx.state.env, "OPTIND", String(optind + 1));
      envSet(ctx.state.env, "__GETOPTS_CHARINDEX", "0");
    }

    return {
      exitCode: invalidVarName ? 2 : 0,
      stdout: EMPTY,
      stderr: encode(stderrMsg),
    };
  }

  // Check if this option requires an argument
  const requiresArg =
    optIndex + 1 < actualOptstring.length &&
    actualOptstring[optIndex + 1] === ":";

  if (requiresArg) {
    // Option requires an argument
    // Check if there are more characters in the current arg (e.g., -cVALUE)
    if (startIndex + 1 < currentArg.length) {
      // Rest of current arg is the argument
      envSet(ctx.state.env, "OPTARG", currentArg.slice(startIndex + 1));
      envSet(ctx.state.env, "OPTIND", String(optind + 1));
      envSet(ctx.state.env, "__GETOPTS_CHARINDEX", "0");
    } else {
      // Next argument is the option argument
      if (optind >= argsToProcess.length) {
        // No argument provided
        let stderrMsg = "";
        if (!silentMode) {
          stderrMsg = `bash: option requires an argument -- ${optChar}\n`;
          if (!invalidVarName) {
            envSet(ctx.state.env, varName, "?");
          }
        } else {
          envSet(ctx.state.env, "OPTARG", optChar);
          if (!invalidVarName) {
            envSet(ctx.state.env, varName, ":");
          }
        }
        envSet(ctx.state.env, "OPTIND", String(optind + 1));
        envSet(ctx.state.env, "__GETOPTS_CHARINDEX", "0");
        return {
          exitCode: invalidVarName ? 2 : 0,
          stdout: EMPTY,
          stderr: encode(stderrMsg),
        };
      }
      envSet(ctx.state.env, "OPTARG", argsToProcess[optind]); // Next arg (0-indexed: optind)
      envSet(ctx.state.env, "OPTIND", String(optind + 2));
      envSet(ctx.state.env, "__GETOPTS_CHARINDEX", "0");
    }
  } else {
    // Option doesn't require an argument
    // Move to next character or next argument
    if (startIndex + 1 < currentArg.length) {
      envSet(ctx.state.env, "__GETOPTS_CHARINDEX", String(startIndex + 1));
      envSet(ctx.state.env, "OPTIND", String(optind)); // Always set OPTIND
    } else {
      envSet(ctx.state.env, "OPTIND", String(optind + 1));
      envSet(ctx.state.env, "__GETOPTS_CHARINDEX", "0");
    }
  }

  // Set the variable to the option character (if valid variable name)
  if (!invalidVarName) {
    envSet(ctx.state.env, varName, optChar);
  }

  return { exitCode: invalidVarName ? 2 : 0, stdout: EMPTY, stderr: EMPTY };
}
