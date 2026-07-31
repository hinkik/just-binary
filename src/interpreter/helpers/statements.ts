/**
 * Statement execution helpers for the interpreter.
 *
 * Consolidates the common pattern of executing a list of statements
 * and accumulating their output.
 */

import type { StatementNode } from "../../ast/types.js";
import type { ExecResult } from "../../types.js";
import { emptyStream } from "../../utils/stream.js";
import {
  ErrexitError,
  ExecutionLimitError,
  ExitError,
  isScopeExitError,
  SubshellExitError,
} from "../errors.js";
import { pumpResult, writeErrorDiagnostic } from "../output-channels.js";
import type { InterpreterContext } from "../types.js";
import { getErrorMessage } from "./errors.js";
import { failure } from "./result.js";

/**
 * Execute a list of statements and accumulate their output.
 * Handles scope exit errors (break, continue, return) and errexit properly.
 *
 * @param ctx - Interpreter context
 * @param statements - Statements to execute
 * @returns Empty streams and the final exit code
 */
export async function executeStatements(
  ctx: InterpreterContext,
  statements: StatementNode[],
): Promise<ExecResult> {
  let exitCode = 0;

  try {
    for (const stmt of statements) {
      const result = await ctx.executeStatement(stmt);
      await pumpResult(ctx, result);
      exitCode = result.exitCode;
    }
  } catch (error) {
    const diagnosticWritten = await writeErrorDiagnostic(ctx, error);
    if (
      isScopeExitError(error) ||
      error instanceof ErrexitError ||
      error instanceof ExitError ||
      error instanceof ExecutionLimitError ||
      error instanceof SubshellExitError
    ) {
      throw error;
    }
    if (!diagnosticWritten) {
      const message = getErrorMessage(error);
      await pumpResult(
        ctx,
        failure(message.endsWith("\n") ? message : `${message}\n`),
      );
    }
    return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 1 };
  }

  return {
    stdout: emptyStream(),
    stderr: emptyStream(),
    exitCode,
  };
}
