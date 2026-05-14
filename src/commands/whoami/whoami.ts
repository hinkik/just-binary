/**
 * whoami - print effective user name
 *
 * Usage: whoami
 *
 * In sandboxed environment, always returns "user".
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { emptyStream, fromString } from "../../utils/stream.js";

async function whoamiExecute(
  _args: Uint8Array[],
  _ctx: CommandContext,
): Promise<ExecResult> {
  // In sandboxed environment, always return "user"
  return { stdout: fromString("user\n"), stderr: emptyStream(), exitCode: 0 };
}

export const whoami: Command = {
  name: "whoami",
  execute: whoamiExecute,
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "whoami",
  flags: [],
};
