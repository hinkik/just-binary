/**
 * hostname - show or set the system's host name
 *
 * Usage: hostname [NAME]
 *
 * In sandboxed environment, always returns "localhost".
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";

async function hostnameExecute(
  _args: Uint8Array[],
  _ctx: CommandContext,
): Promise<ExecResult> {
  // In sandboxed environment, always return "localhost"
  return {
    stdout: fromString("localhost\n"),
    stderr: emptyStream(),
    exitCode: 0,
  };
}

export const hostname: Command = {
  name: "hostname",
  execute: hostnameExecute,
};

import { emptyStream, fromString } from "../../utils/stream.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "hostname",
  flags: [],
};
