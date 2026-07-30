/**
 * ExecResult factory functions for cleaner code.
 *
 * These helpers reduce verbosity and improve readability when
 * constructing ExecResult objects throughout the interpreter.
 *
 * IMPORTANT: stdout/stderr are now ByteStreams (single-use). Use factory
 * functions like ok() instead of a shared constant — a constant ExecResult
 * with stream fields breaks the second time it's consumed.
 */

import type { ExecResult } from "../../types.js";
import type { ByteStream } from "../../utils/stream.js";
import { emptyStream, fromBytes, fromString } from "../../utils/stream.js";
import { ExecutionLimitError } from "../errors.js";

/**
 * Factory: build a successful no-output result.
 * Streams are single-use, so each call returns a fresh ExecResult.
 */
export function ok(): ExecResult {
  return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 0 };
}

/**
 * Backwards-compatible alias — a getter so each access returns a fresh
 * ExecResult with new streams. Callers that destructure or use this in a
 * pipeline must not reuse the same reference twice.
 */
export const OK = {
  get stdout(): ByteStream {
    return emptyStream();
  },
  get stderr(): ByteStream {
    return emptyStream();
  },
  exitCode: 0,
} as ExecResult;

/**
 * Create a successful result with optional stdout stream.
 */
export function success(stdout: ByteStream = emptyStream()): ExecResult {
  return { stdout, stderr: emptyStream(), exitCode: 0 };
}

/**
 * Create a successful result from a text string.
 */
export function successText(stdout: string): ExecResult {
  return {
    stdout: fromString(stdout),
    stderr: emptyStream(),
    exitCode: 0,
  };
}

/**
 * Create a failure result with stderr message.
 */
export function failure(stderr: string, exitCode = 1): ExecResult {
  return {
    stdout: emptyStream(),
    stderr: fromString(stderr),
    exitCode,
  };
}

/**
 * Create a result with all fields specified.
 * Accepts Uint8Array or ByteStream for each; bytes are wrapped via fromBytes.
 */
export function result(
  stdout: Uint8Array | ByteStream,
  stderr: Uint8Array | ByteStream,
  exitCode: number,
): ExecResult {
  return {
    stdout: stdout instanceof Uint8Array ? fromBytes(stdout) : stdout,
    stderr: stderr instanceof Uint8Array ? fromBytes(stderr) : stderr,
    exitCode,
  };
}

/**
 * Convert a boolean test result to an ExecResult.
 */
export function testResult(passed: boolean): ExecResult {
  return {
    stdout: emptyStream(),
    stderr: emptyStream(),
    exitCode: passed ? 0 : 1,
  };
}

/**
 * Throw an ExecutionLimitError for execution limits (recursion, iterations, commands).
 */
export function throwExecutionLimit(
  message: string,
  limitType: "recursion" | "iterations" | "commands",
): never {
  throw new ExecutionLimitError(message, limitType);
}
