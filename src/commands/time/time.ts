import { mapToRecord } from "../../helpers/env.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import { concat, decodeArgs, EMPTY, encode } from "../../utils/bytes.js";

/**
 * time - time command execution
 *
 * Usage: time [-f FORMAT] [-o FILE] [-a] [-v] [-p] command [arguments...]
 *
 * Times the execution of a command and outputs timing statistics.
 *
 * Options:
 *   -f FORMAT    Use FORMAT for output (GNU time format specifiers)
 *   -o FILE      Write timing output to FILE
 *   -a           Append to output file (with -o)
 *   -v           Verbose output
 *   -p           POSIX portable output format
 *
 * Format specifiers:
 *   %e    Elapsed real time in seconds
 *   %M    Maximum resident set size (KB)
 *   %S    System CPU time (seconds)
 *   %U    User CPU time (seconds)
 *
 * Note: In this JavaScript implementation, user/system CPU time and memory
 * metrics are not available, so %M, %S, %U output 0.
 */
export const timeCommand: Command = {
  name: "time",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    // Parse options
    let format = "%e %M"; // Default format
    let outputFile: string | null = null;
    let appendMode = false;
    let posixFormat = false;
    let i = 0;

    while (i < a.length) {
      const arg = a[i];

      if (arg === "-f" || arg === "--format") {
        i++;
        if (i >= a.length) {
          return {
            stdout: EMPTY,
            stderr: encode("time: missing argument to '-f'\n"),
            exitCode: 1,
          };
        }
        format = a[i];
        i++;
      } else if (arg === "-o" || arg === "--output") {
        i++;
        if (i >= a.length) {
          return {
            stdout: EMPTY,
            stderr: encode("time: missing argument to '-o'\n"),
            exitCode: 1,
          };
        }
        outputFile = a[i];
        i++;
      } else if (arg === "-a" || arg === "--append") {
        appendMode = true;
        i++;
      } else if (arg === "-v" || arg === "--verbose") {
        // Verbose mode - use a detailed format
        format =
          "Command being timed: %C\nElapsed (wall clock) time: %e seconds\nMaximum resident set size (kbytes): %M";
        i++;
      } else if (arg === "-p" || arg === "--portability") {
        posixFormat = true;
        i++;
      } else if (arg === "--") {
        i++;
        break;
      } else if (arg.startsWith("-")) {
        // Unknown option - skip it (be permissive like GNU time)
        i++;
      } else {
        // Start of command
        break;
      }
    }

    // Get the command to time
    const commandArgs = a.slice(i);

    if (commandArgs.length === 0) {
      // No command specified - just return success (matches GNU time behavior)
      return {
        stdout: EMPTY,
        stderr: EMPTY,
        exitCode: 0,
      };
    }

    // Record start time
    const startTime = performance.now();

    // Execute the command
    const commandString = commandArgs.join(" ");
    let result: ExecResult;

    try {
      if (!ctx.exec) {
        return {
          stdout: EMPTY,
          stderr: encode("time: exec not available\n"),
          exitCode: 1,
        };
      }
      result = await ctx.exec(commandString, {
        env: mapToRecord(ctx.env),
        cwd: ctx.cwd,
      });
    } catch (error) {
      result = {
        stdout: EMPTY,
        stderr: encode(`time: ${(error as Error).message}\n`),
        exitCode: 127,
      };
    }

    // Record end time
    const endTime = performance.now();
    const elapsedSeconds = (endTime - startTime) / 1000;

    // Format the timing output
    let timingOutput: string;

    if (posixFormat) {
      // POSIX format: real, user, sys
      timingOutput = `real ${elapsedSeconds.toFixed(2)}\nuser 0.00\nsys 0.00\n`;
    } else {
      // Apply format specifiers
      timingOutput = format
        .replace(/%e/g, elapsedSeconds.toFixed(2))
        .replace(/%E/g, formatElapsedTime(elapsedSeconds))
        .replace(/%M/g, "0") // Max resident set size - not available in JS
        .replace(/%S/g, "0.00") // System CPU time - not available in JS
        .replace(/%U/g, "0.00") // User CPU time - not available in JS
        .replace(/%P/g, "0%") // CPU percentage - not available in JS
        .replace(/%C/g, commandString); // Command being timed

      // Add newline if not present
      if (!timingOutput.endsWith("\n")) {
        timingOutput += "\n";
      }
    }

    // Output timing info
    if (outputFile) {
      // Write to file
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, outputFile);
        if (appendMode && (await ctx.fs.exists(filePath))) {
          const existing = await ctx.fs.readFile(filePath);
          await ctx.fs.writeFile(filePath, existing + timingOutput);
        } else {
          await ctx.fs.writeFile(filePath, timingOutput);
        }
      } catch (error) {
        return {
          stdout: result.stdout,
          stderr: concat(
            result.stderr,
            encode(
              `time: cannot write to '${outputFile}': ${(error as Error).message}\n`,
            ),
          ),
          exitCode: result.exitCode,
        };
      }
    } else {
      // Output to stderr (standard behavior for time)
      result = {
        ...result,
        stderr: concat(result.stderr, encode(timingOutput)),
      };
    }

    return result;
  },
};

/**
 * Format elapsed time in [hours:]minutes:seconds format
 */
function formatElapsedTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.toFixed(2).padStart(5, "0")}`;
  }
  return `${minutes}:${secs.toFixed(2).padStart(5, "0")}`;
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "time",
  flags: [{ flag: "-p", type: "boolean" }],
  needsArgs: true,
};
