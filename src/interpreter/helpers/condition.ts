/**
 * Condition execution helper for the interpreter.
 *
 * Handles executing condition statements with proper inCondition state management.
 * Used by if, while, and until loops.
 */

import type { StatementNode } from "../../ast/types.js";
import type { ExecResult } from "../../types.js";
import { concat, EMPTY } from "../../utils/bytes.js";
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

  let stdout: Uint8Array = EMPTY;
  let stderr: Uint8Array = EMPTY;
  let exitCode = 0;

  try {
    for (const stmt of statements) {
      const result = await ctx.executeStatement(stmt);
      stdout = concat(stdout, result.stdout);
      stderr = concat(stderr, result.stderr);
      exitCode = result.exitCode;
    }
  } finally {
    ctx.state.inCondition = savedInCondition;
  }

  return { stdout, stderr, exitCode };
}
