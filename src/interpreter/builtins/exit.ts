/**
 * exit - Exit shell builtin
 */

import { ExitError } from "../errors.js";
import { writeToChannel } from "../output-channels.js";
import type { InterpreterContext } from "../types.js";

export async function handleExit(
  ctx: InterpreterContext,
  args: string[],
): Promise<never> {
  let exitCode: number;
  let diagnostic: string | undefined;

  if (args.length === 0) {
    // Use last command's exit code when no argument given
    exitCode = ctx.state.lastExitCode;
  } else {
    const arg = args[0];
    const parsed = Number.parseInt(arg, 10);
    // Empty string or non-numeric is an error
    if (arg === "" || Number.isNaN(parsed) || !/^-?\d+$/.test(arg)) {
      diagnostic = `bash: exit: ${arg}: numeric argument required\n`;
      exitCode = 2;
    } else {
      // Exit codes are modulo 256 (wrap around)
      exitCode = ((parsed % 256) + 256) % 256;
    }
  }

  if (diagnostic) {
    await writeToChannel(ctx, 2, diagnostic, true);
  }
  throw new ExitError(exitCode);
}
