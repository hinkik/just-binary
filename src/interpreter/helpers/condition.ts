/**
 * Condition execution helper for the interpreter.
 *
 * Handles executing condition statements with proper inCondition state management.
 * Used by if, while, and until loops.
 */

import type { StatementNode } from "../../ast/types.js";
import type { ExecResult } from "../../types.js";
import {
  type ByteStream,
  concatStreams,
  emptyStream,
} from "../../utils/stream.js";
import type { InterpreterContext } from "../types.js";

/**
 * Execute condition statements with inCondition flag set.
 * This prevents errexit from triggering during condition evaluation.
 *
 * @param ctx - Interpreter context
 * @param statements - Condition statements to execute
 * @returns Accumulated stdout, stderr, and final exit code
 */
export async function executeCondition(
  ctx: InterpreterContext,
  statements: StatementNode[],
): Promise<ExecResult> {
  const savedInCondition = ctx.state.inCondition;
  ctx.state.inCondition = true;

  let stdout: ByteStream = emptyStream();
  let stderr: ByteStream = emptyStream();
  let exitCode = 0;

  try {
    for (const stmt of statements) {
      const result = await ctx.executeStatement(stmt);
      stdout = concatStreams(stdout, result.stdout);
      stderr = concatStreams(stderr, result.stderr);
      exitCode = result.exitCode;
    }
  } finally {
    ctx.state.inCondition = savedInCondition;
  }

  return { stdout, stderr, exitCode };
}
