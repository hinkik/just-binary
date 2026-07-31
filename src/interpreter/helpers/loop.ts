/**
 * Loop Error Handling Helpers
 *
 * Consolidates the repeated error handling logic used in all loop constructs
 * (for, c-style for, while, until).
 */

import {
  BreakError,
  ContinueError,
  ErrexitError,
  ExecutionLimitError,
  ExitError,
  ReturnError,
} from "../errors.js";

export type LoopAction = "break" | "continue" | "rethrow" | "error";

export interface LoopErrorResult {
  action: LoopAction;
  exitCode?: number;
  error?: unknown;
}

/**
 * Handle errors thrown during loop body execution.
 *
 * @param error - The caught error
 * @param loopDepth - Current loop nesting depth from ctx.state.loopDepth
 * @returns Result indicating what action the loop should take
 */
export function handleLoopError(
  error: unknown,
  loopDepth: number,
): LoopErrorResult {
  if (error instanceof BreakError) {
    // Only propagate if levels > 1 AND we're not at the outermost loop
    // Per bash docs: "If n is greater than the number of enclosing loops,
    // the last enclosing loop is exited"
    if (error.levels > 1 && loopDepth > 1) {
      error.levels--;
      return { action: "rethrow", error };
    }
    return { action: "break" };
  }

  if (error instanceof ContinueError) {
    // Only propagate if levels > 1 AND we're not at the outermost loop
    // Per bash docs: "If n is greater than the number of enclosing loops,
    // the last enclosing loop is resumed"
    if (error.levels > 1 && loopDepth > 1) {
      error.levels--;
      return { action: "rethrow", error };
    }
    return { action: "continue" };
  }

  if (
    error instanceof ReturnError ||
    error instanceof ErrexitError ||
    error instanceof ExitError ||
    error instanceof ExecutionLimitError
  ) {
    return { action: "rethrow", error };
  }

  return {
    action: "error",
    exitCode: 1,
    error,
  };
}
