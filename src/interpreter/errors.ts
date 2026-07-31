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
 */

/**
 * Base class for all control flow errors.
 */
abstract class ControlFlowError extends Error {}

/**
 * Error thrown when break is called to exit loops.
 */
export class BreakError extends ControlFlowError {
  readonly name = "BreakError";

  constructor(public levels: number = 1) {
    super("break");
  }
}

/**
 * Error thrown when continue is called to skip to next iteration.
 */
export class ContinueError extends ControlFlowError {
  readonly name = "ContinueError";

  constructor(public levels: number = 1) {
    super("continue");
  }
}

/**
 * Error thrown when return is called to exit a function.
 */
export class ReturnError extends ControlFlowError {
  readonly name = "ReturnError";

  constructor(public exitCode: number = 0) {
    super("return");
  }
}

/**
 * Error thrown when set -e (errexit) is enabled and a command fails.
 */
export class ErrexitError extends ControlFlowError {
  readonly name = "ErrexitError";

  constructor(public readonly exitCode: number) {
    super(`errexit: command exited with status ${exitCode}`);
  }
}

/**
 * Error thrown when set -u (nounset) is enabled and an unset variable is referenced.
 */
export class NounsetError extends ControlFlowError {
  readonly name = "NounsetError";

  constructor(public varName: string) {
    super(`${varName}: unbound variable`);
  }
}

/**
 * Error thrown when exit builtin is called to terminate the script.
 */
export class ExitError extends ControlFlowError {
  readonly name = "ExitError";

  constructor(public readonly exitCode: number) {
    super("exit");
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
    fatal = false,
    public readonly reportDiagnostic = true,
  ) {
    super(message);
    this.fatal = fatal;
  }
}

/**
 * Error thrown for bad substitution errors (e.g., ${#var:1:3}).
 * Returns exit code 1.
 */
export class BadSubstitutionError extends ControlFlowError {
  readonly name = "BadSubstitutionError";
}

/**
 * Error thrown when failglob is enabled and a glob pattern has no matches.
 * Returns exit code 1.
 */
export class GlobError extends ControlFlowError {
  readonly name = "GlobError";

  constructor(public readonly pattern: string) {
    super(`no match: ${pattern}`);
  }
}

/**
 * Error thrown for invalid brace expansions (e.g., mixed case character ranges like {z..A}).
 * Returns exit code 1 (matching bash behavior).
 */
export class BraceExpansionError extends ControlFlowError {
  readonly name = "BraceExpansionError";
}

/**
 * Error thrown when execution limits are exceeded (recursion depth, command count, loop iterations).
 * This should ALWAYS be thrown before JavaScript's native RangeError kicks in.
 * Exit code 126 indicates a limit was exceeded.
 */
export class ExecutionLimitError extends ControlFlowError {
  readonly name: string = "ExecutionLimitError";
  static readonly EXIT_CODE = 126;

  constructor(
    message: string,
    public readonly limitType:
      | "recursion"
      | "commands"
      | "iterations"
      | "string_length"
      | "glob_operations"
      | "substitution_depth"
      | "aborted",
  ) {
    super(message);
  }
}

/**
 * Map an AbortSignal reason to the exit code a killed process would have.
 * Matches real shell conventions: 128 + signal number.
 */
export function abortExitCode(reason: unknown): number {
  if (reason instanceof DOMException && reason.name === "TimeoutError") {
    // AbortSignal.timeout() — same as GNU timeout's deadline kill
    return 124;
  }
  if (
    typeof reason === "number" &&
    Number.isInteger(reason) &&
    reason > 0 &&
    reason < 128
  ) {
    return 128 + reason;
  }
  switch (reason) {
    case "SIGINT":
      return 130;
    case "SIGKILL":
      return 137;
    case "SIGTERM":
      return 143;
    default:
      return 143;
  }
}

/**
 * Error thrown when execution is cancelled via ExecOptions.signal.
 *
 * Extends ExecutionLimitError so every existing "safety limits must always
 * propagate" rethrow site treats cancellation the same way: it unwinds the
 * whole execution instead of being converted to a local exit code.
 *
 * Unlike limit errors, aborted commands die silently (like a killed process).
 *
 * Numeric signal reasons map to 128 + signal. String reasons
 * "SIGINT"/"SIGKILL"/"SIGTERM" map to 130/137/143,
 * AbortSignal.timeout()'s TimeoutError maps to 124, and anything else defaults
 * to 143 (killed by SIGTERM).
 */
export class AbortExecutionError extends ExecutionLimitError {
  override readonly name: string = "AbortExecutionError";
  readonly exitCode: number;

  constructor(reason: unknown) {
    super("execution aborted", "aborted");
    this.exitCode = abortExitCode(reason);
  }
}

/**
 * Throw AbortExecutionError if the signal has been aborted.
 * Cooperative cancellation check — called at statement dispatch and loop
 * guards, and by leaf commands before/after long waits.
 */
export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new AbortExecutionError(signal.reason);
  }
}

/**
 * Error thrown when break/continue is called in a subshell that was
 * spawned from within a loop context. Causes the subshell to exit cleanly.
 */
export class SubshellExitError extends ControlFlowError {
  readonly name = "SubshellExitError";

  constructor() {
    super("subshell exit");
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
 */
export class PosixFatalError extends ControlFlowError {
  readonly name = "PosixFatalError";

  constructor(public readonly exitCode: number) {
    super("posix fatal error");
  }
}
