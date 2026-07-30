/**
 * Condition execution helper for the interpreter.
 *
 * Handles executing condition statements with proper inCondition state management.
 * Used by if, while, and until loops.
 */

import type { StatementNode } from "../../ast/types.js";
import type { ExecResult } from "../../types.js";
import { emptyStream } from "../../utils/stream.js";
import { pumpErrorStreams, pumpResult } from "../output-channels.js";
import type { InterpreterContext } from "../types.js";

/**
 * Execute condition statements with inCondition flag set.
 * This prevents errexit from triggering during condition evaluation.
 *
 * @param ctx - Interpreter context
 * @param statements - Condition statements to execute
 * @returns Empty streams and the final exit code
 */
export async function executeCondition(
  ctx: InterpreterContext,
  statements: StatementNode[],
): Promise<ExecResult> {
  const savedInCondition = ctx.state.inCondition;
  ctx.state.inCondition = true;

  let exitCode = 0;

  try {
    for (const stmt of statements) {
      const result = await ctx.executeStatement(stmt);
      await pumpResult(ctx, result);
      exitCode = result.exitCode;
    }
  } catch (error) {
    await pumpErrorStreams(ctx, error);
    throw error;
  } finally {
    ctx.state.inCondition = savedInCondition;
  }

  return {
    stdout: emptyStream(),
    stderr: emptyStream(),
    exitCode,
  };
}
