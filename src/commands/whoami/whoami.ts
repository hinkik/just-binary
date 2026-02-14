/**
 * whoami - print effective user name
 *
 * Usage: whoami
 *
 * In sandboxed environment, always returns "user".
 */

import type { Command, CommandContext, ExecResult } from "../../types.js";
import { EMPTY, encode } from "../../utils/bytes.js";

async function whoamiExecute(
  _args: Uint8Array[],
  _ctx: CommandContext,
): Promise<ExecResult> {
  // In sandboxed environment, always return "user"
  return { stdout: encode("user\n"), stderr: EMPTY, exitCode: 0 };
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
