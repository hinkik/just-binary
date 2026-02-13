/**
 * Control Flow Errors
 *
 * Error classes used to implement shell control flow:
 * - break: Exit loops
 * - continue: Skip to next iteration
 * - return: Exit functions
 * - errexit: Exit on error (set -e)
 * - nounset: Error on unset variables (set -u)
 *
 * All control flow errors carry stdout/stderr to accumulate output
 * as they propagate through the execution stack.
 */

import { concat, EMPTY, encode } from "../utils/bytes.js";

/**
 * Base class for all control flow errors.
 * Carries stdout/stderr to preserve output during propagation.
 */
abstract class ControlFlowError extends Error {
  constructor(
    message: string,
    public stdout: Uint8Array = EMPTY,
    public stderr: Uint8Array = EMPTY,
  ) {
    super(message);
  }

  /**
   * Prepend output from the current context before re-throwing.
   */
  prependOutput(stdout: Uint8Array, stderr: Uint8Array): void {
    this.stdout = concat(stdout, this.stdout);
    this.stderr = concat(stderr, this.stderr);
  }
}

/**
 * Error thrown when break is called to exit loops.
 */
export class BreakError extends ControlFlowError {
  readonly name = "BreakError";

  constructor(
    public levels: number = 1,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super("break", stdout, stderr);
  }
}

/**
 * Error thrown when continue is called to skip to next iteration.
 */
export class ContinueError extends ControlFlowError {
  readonly name = "ContinueError";

  constructor(
    public levels: number = 1,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super("continue", stdout, stderr);
  }
}

/**
 * Error thrown when return is called to exit a function.
 */
export class ReturnError extends ControlFlowError {
  readonly name = "ReturnError";

  constructor(
    public exitCode: number = 0,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super("return", stdout, stderr);
  }
}

/**
 * Error thrown when set -e (errexit) is enabled and a command fails.
 */
export class ErrexitError extends ControlFlowError {
  readonly name = "ErrexitError";

  constructor(
    public readonly exitCode: number,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super(`errexit: command exited with status ${exitCode}`, stdout, stderr);
  }
}

/**
 * Error thrown when set -u (nounset) is enabled and an unset variable is referenced.
 */
export class NounsetError extends ControlFlowError {
  readonly name = "NounsetError";

  constructor(
    public varName: string,
    stdout: Uint8Array = EMPTY,
  ) {
    super(
      `${varName}: unbound variable`,
      stdout,
      encode(`bash: ${varName}: unbound variable\n`),
    );
  }
}

/**
 * Error thrown when exit builtin is called to terminate the script.
 */
export class ExitError extends ControlFlowError {
  readonly name = "ExitError";

  constructor(
    public readonly exitCode: number,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super(`exit`, stdout, stderr);
  }
}

/**
 * Error thrown for arithmetic expression errors (e.g., floating point, invalid syntax).
 * Returns exit code 1 instead of 2 (syntax error).
 */
export class ArithmeticError extends ControlFlowError {
  readonly name = "ArithmeticError";

  /**
   * If true, this error should abort script execution (like missing operand after binary operator).
   * If false, the error is recoverable and execution can continue.
   */
  public fatal: boolean;

  constructor(
    message: string,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
    fatal = false,
  ) {
    super(message, stdout, stderr);
    this.stderr = stderr.length > 0 ? stderr : encode(`bash: ${message}\n`);
    this.fatal = fatal;
  }
}

/**
 * Error thrown for bad substitution errors (e.g., ${#var:1:3}).
 * Returns exit code 1.
 */
export class BadSubstitutionError extends ControlFlowError {
  readonly name = "BadSubstitutionError";

  constructor(
    message: string,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super(message, stdout, stderr);
    this.stderr =
      stderr.length > 0
        ? stderr
        : encode(`bash: ${message}: bad substitution\n`);
  }
}

/**
 * Error thrown when failglob is enabled and a glob pattern has no matches.
 * Returns exit code 1.
 */
export class GlobError extends ControlFlowError {
  readonly name = "GlobError";

  constructor(
    pattern: string,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super(`no match: ${pattern}`, stdout, stderr);
    this.stderr =
      stderr.length > 0 ? stderr : encode(`bash: no match: ${pattern}\n`);
  }
}

/**
 * Error thrown for invalid brace expansions (e.g., mixed case character ranges like {z..A}).
 * Returns exit code 1 (matching bash behavior).
 */
export class BraceExpansionError extends ControlFlowError {
  readonly name = "BraceExpansionError";

  constructor(
    message: string,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super(message, stdout, stderr);
    this.stderr = stderr.length > 0 ? stderr : encode(`bash: ${message}\n`);
  }
}

/**
 * Error thrown when execution limits are exceeded (recursion depth, command count, loop iterations).
 * This should ALWAYS be thrown before JavaScript's native RangeError kicks in.
 * Exit code 126 indicates a limit was exceeded.
 */
export class ExecutionLimitError extends ControlFlowError {
  readonly name = "ExecutionLimitError";
  static readonly EXIT_CODE = 126;

  constructor(
    message: string,
    public readonly limitType:
      | "recursion"
      | "commands"
      | "iterations"
      | "string_length"
      | "glob_operations"
      | "substitution_depth",
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super(message, stdout, stderr);
    this.stderr = stderr.length > 0 ? stderr : encode(`bash: ${message}\n`);
  }
}

/**
 * Error thrown when break/continue is called in a subshell that was
 * spawned from within a loop context. Causes the subshell to exit cleanly.
 */
export class SubshellExitError extends ControlFlowError {
  readonly name = "SubshellExitError";

  constructor(stdout: Uint8Array = EMPTY, stderr: Uint8Array = EMPTY) {
    super("subshell exit", stdout, stderr);
  }
}

/**
 * Type guard for errors that exit the current scope (return, break, continue).
 * These need special handling vs errexit/nounset which terminate execution.
 */
export function isScopeExitError(
  error: unknown,
): error is BreakError | ContinueError | ReturnError {
  return (
    error instanceof BreakError ||
    error instanceof ContinueError ||
    error instanceof ReturnError
  );
}

/**
 * Error thrown when a POSIX special builtin fails in POSIX mode.
 * In POSIX mode (set -o posix), errors in special builtins like
 * shift, set, readonly, export, etc. cause the entire script to exit.
 *
 * Per POSIX 2.8.1 - Consequences of Shell Errors:
 * "A special built-in utility causes an interactive or non-interactive shell
 * to exit when an error occurs."
 */
export class PosixFatalError extends ControlFlowError {
  readonly name = "PosixFatalError";

  constructor(
    public readonly exitCode: number,
    stdout: Uint8Array = EMPTY,
    stderr: Uint8Array = EMPTY,
  ) {
    super("posix fatal error", stdout, stderr);
  }
}
