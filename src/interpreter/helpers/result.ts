/**
 * ExecResult factory functions for cleaner code.
 *
 * These helpers reduce verbosity and improve readability when
 * constructing ExecResult objects throughout the interpreter.
 */

import type { ExecResult } from "../../types.js";
import { EMPTY, encode } from "../../utils/bytes.js";
import { ExecutionLimitError } from "../errors.js";

/**
 * A successful result with no output.
 * Use this for commands that succeed silently.
 */
export const OK: ExecResult = Object.freeze({
  stdout: EMPTY,
  stderr: EMPTY,
  exitCode: 0,
});

/**
 * Create a successful result with optional stdout bytes.
 *
 * @param stdout - Output bytes to include (default: EMPTY)
 * @returns ExecResult with exitCode 0
 */
export function success(stdout: Uint8Array = EMPTY): ExecResult {
  return { stdout, stderr: EMPTY, exitCode: 0 };
}

/**
 * Create a successful result from a text string.
 * Convenience wrapper that encodes the string to UTF-8.
 *
 * @param stdout - Text output to include
 * @returns ExecResult with exitCode 0
 */
export function successText(stdout: string): ExecResult {
  return { stdout: encode(stdout), stderr: EMPTY, exitCode: 0 };
}

/**
 * Create a failure result with stderr message.
 *
 * @param stderr - Error message to include
 * @param exitCode - Exit code (default: 1)
 * @returns ExecResult with the specified exitCode
 */
export function failure(stderr: string, exitCode = 1): ExecResult {
  return { stdout: EMPTY, stderr: encode(stderr), exitCode };
}

/**
 * Create a result with all fields specified.
 *
 * @param stdout - Standard output bytes
 * @param stderr - Standard error bytes
 * @param exitCode - Exit code
 * @returns ExecResult with all fields
 */
export function result(
  stdout: Uint8Array,
  stderr: Uint8Array,
  exitCode: number,
): ExecResult {
  return { stdout, stderr, exitCode };
}

/**
 * Convert a boolean test result to an ExecResult.
 * Useful for test/conditional commands where true = exit 0, false = exit 1.
 *
 * @param passed - Boolean test result
 * @returns ExecResult with exitCode 0 if passed, 1 otherwise
 */
export function testResult(passed: boolean): ExecResult {
  return { stdout: EMPTY, stderr: EMPTY, exitCode: passed ? 0 : 1 };
}

/**
 * Throw an ExecutionLimitError for execution limits (recursion, iterations, commands).
 *
 * @param message - Error message describing the limit exceeded
 * @param limitType - Type of limit exceeded
 * @param stdout - Accumulated stdout to include
 * @param stderr - Accumulated stderr to include
 * @throws ExecutionLimitError always
 */
export function throwExecutionLimit(
  message: string,
  limitType: "recursion" | "iterations" | "commands",
  stdout: Uint8Array = EMPTY,
  stderr: Uint8Array = EMPTY,
): never {
  throw new ExecutionLimitError(message, limitType, stdout, stderr);
}
