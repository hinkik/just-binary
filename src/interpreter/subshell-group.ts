/**
 * Subshell, Group, and Script Execution
 *
 * Handles execution of subshells (...), groups { ...; }, and user scripts
 */

import type {
  GroupNode,
  HereDocNode,
  ScriptNode,
  StatementNode,
  SubshellNode,
  WordNode,
} from "../ast/types.js";
import { Parser } from "../parser/parser.js";
import type { ParseException } from "../parser/types.js";
import type { ExecResult } from "../types.js";
import { envSet } from "../utils/bytes.js";
import {
  type ByteStream,
  collectBytes,
  emptyStream,
  fromBytes,
  fromString,
} from "../utils/stream.js";
import {
  BreakError,
  ContinueError,
  ErrexitError,
  ExecutionLimitError,
  ExitError,
  isScopeExitError,
  PosixFatalError,
  ReturnError,
  SubshellExitError,
} from "./errors.js";
import { expandWord } from "./expansion.js";
import { getErrorMessage } from "./helpers/errors.js";
import { failure, result } from "./helpers/result.js";
import {
  cloneOutputChannels,
  executeAndPumpResult,
  withChannels,
  writeErrorDiagnostic,
  writeErrorDiagnosticWithWriteFailure,
} from "./output-channels.js";
import {
  type CompiledOutputRedirections,
  compileOutputRedirections,
} from "./redirect-channels.js";
import { processFdVariableRedirections } from "./redirections.js";
import type { InterpreterContext } from "./types.js";

/**
 * Type for executeStatement callback
 */
export type ExecuteStatementFn = (stmt: StatementNode) => Promise<ExecResult>;

/**
 * Execute a subshell node (...).
 * Creates an isolated execution environment that doesn't affect the parent.
 */
export async function executeSubshell(
  ctx: InterpreterContext,
  node: SubshellNode,
  stdin: ByteStream,
  executeStatement: ExecuteStatementFn,
): Promise<ExecResult> {
  // A subshell gets its own descriptor table, but the installed sinks are
  // shared so writes remain live. Redirections are scoped to this clone.
  const subshellChannels = cloneOutputChannels(ctx.outputChannels);
  const savedEnv = new Map(ctx.state.env);
  const savedCwd = ctx.state.cwd;
  const savedFileDescriptors = ctx.state.fileDescriptors;
  const savedNextFd = ctx.state.nextFd;
  ctx.state.fileDescriptors = savedFileDescriptors
    ? new Map(savedFileDescriptors)
    : undefined;
  // Save options so subshell changes (like set -e) don't affect parent
  const savedOptions = { ...ctx.state.options };

  // Save functions so subshell definitions don't leak to parent
  // This is critical for proper subshell isolation - in real bash, function
  // definitions inside (...) are isolated and don't affect the parent shell
  // Note: Aliases are stored in env with BASH_ALIAS_ prefix, so they're
  // already isolated via savedEnv
  const savedFunctions = new Map(ctx.state.functions);

  // Save local variable scoping state for subshell isolation
  // Subshell gets a copy of these, but changes don't affect parent
  const savedLocalScopes = ctx.state.localScopes;
  const savedLocalVarStack = ctx.state.localVarStack;
  const savedLocalVarDepth = ctx.state.localVarDepth;
  const savedFullyUnsetLocals = ctx.state.fullyUnsetLocals;

  // Deep copy the local scoping structures for the subshell
  ctx.state.localScopes = savedLocalScopes.map((scope) => new Map(scope));
  if (savedLocalVarStack) {
    ctx.state.localVarStack = new Map();
    for (const [name, stack] of savedLocalVarStack.entries()) {
      ctx.state.localVarStack.set(
        name,
        stack.map((entry) => ({ ...entry })),
      );
    }
  }
  if (savedLocalVarDepth) {
    ctx.state.localVarDepth = new Map(savedLocalVarDepth);
  }
  if (savedFullyUnsetLocals) {
    ctx.state.fullyUnsetLocals = new Map(savedFullyUnsetLocals);
  }

  // Reset loopDepth in subshell - break/continue should not affect parent loops
  const savedLoopDepth = ctx.state.loopDepth;
  // Track if parent has loop context - break/continue in subshell should exit subshell
  const savedParentHasLoopContext = ctx.state.parentHasLoopContext;
  ctx.state.parentHasLoopContext = savedLoopDepth > 0;
  ctx.state.loopDepth = 0;

  // Save $_ (last argument) - subshell execution should not affect parent's $_
  const savedLastArg = ctx.state.lastArg;

  // Subshells get a new BASHPID (unlike $$ which stays the same)
  const savedBashPid = ctx.state.bashPid;
  ctx.state.bashPid = ctx.state.nextVirtualPid++;

  // Save any existing groupStdin and set new one from pipeline
  const savedGroupStdin = ctx.state.groupStdin;

  const restore = (): void => {
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.fileDescriptors = savedFileDescriptors;
    ctx.state.nextFd = savedNextFd;
    ctx.state.options = savedOptions;
    ctx.state.functions = savedFunctions;
    ctx.state.localScopes = savedLocalScopes;
    ctx.state.localVarStack = savedLocalVarStack;
    ctx.state.localVarDepth = savedLocalVarDepth;
    ctx.state.fullyUnsetLocals = savedFullyUnsetLocals;
    ctx.state.loopDepth = savedLoopDepth;
    ctx.state.parentHasLoopContext = savedParentHasLoopContext;
    ctx.state.groupStdin = savedGroupStdin;
    ctx.state.bashPid = savedBashPid;
    ctx.state.lastArg = savedLastArg;
  };

  try {
    // Redirect target expansion belongs to the isolated subshell state too.
    // Snapshotting above ensures assignments performed by an expansion do not
    // leak back to the parent.
    const compiled: CompiledOutputRedirections =
      node.redirections.length === 0
        ? {
            channels: subshellChannels,
            legacyRedirections: [],
          }
        : await compileOutputRedirections(
            ctx,
            subshellChannels,
            node.redirections,
          );
    if (compiled.error) {
      return await withChannels(ctx, compiled.channels, () =>
        executeAndPumpResult(ctx, () =>
          Promise.resolve(compiled.error as ExecResult),
        ),
      );
    }

    return await withChannels(ctx, compiled.channels, async () => {
      const finish = (exitCode: number): ExecResult =>
        result(emptyStream(), emptyStream(), exitCode);

      try {
        // Streams are single-use, so materialize pipeline input once and
        // recreate it for commands inside the subshell. Keep this inside the
        // redirected catch so a lazy-input failure is pumped and blanked there.
        const stdinBytes = await collectBytes(stdin);
        if (stdinBytes.length > 0) {
          ctx.state.groupStdin = fromBytes(stdinBytes);
        }

        let exitCode = 0;
        for (const stmt of node.body) {
          const statementResult = await executeStatement(stmt);
          const pumpedResult = await executeAndPumpResult(ctx, () =>
            Promise.resolve(statementResult),
          );
          exitCode = pumpedResult.exitCode;
        }
        return await finish(exitCode);
      } catch (error) {
        const { diagnosticWritten, writeFailure } =
          await writeErrorDiagnosticWithWriteFailure(ctx, error);
        if (writeFailure) {
          return writeFailure;
        }

        // ExecutionLimitError must always propagate - these are safety limits.
        if (error instanceof ExecutionLimitError) {
          throw error;
        }
        // Break/continue from an outer loop exits this subshell cleanly.
        if (
          error instanceof SubshellExitError ||
          error instanceof BreakError ||
          error instanceof ContinueError
        ) {
          return await finish(0);
        }
        // A subshell translates shell-exit control flow into its own status.
        if (
          error instanceof ExitError ||
          error instanceof ReturnError ||
          error instanceof ErrexitError ||
          error instanceof PosixFatalError
        ) {
          return await finish(error.exitCode);
        }
        if (!diagnosticWritten) {
          await executeAndPumpResult(ctx, () =>
            Promise.resolve(failure(`${getErrorMessage(error)}\n`)),
          );
        }
        return await finish(1);
      }
    });
  } catch (error) {
    // Redirect compilation can throw before the call-local table is available.
    // Report through the subshell's cloned base table.
    await withChannels(ctx, subshellChannels, () =>
      writeErrorDiagnostic(ctx, error),
    );
    throw error;
  } finally {
    restore();
  }
}

/**
 * Execute a group node { ...; }.
 * Runs commands in the current execution environment.
 */
export async function executeGroup(
  ctx: InterpreterContext,
  node: GroupNode,
  stdin: ByteStream,
  executeStatement: ExecuteStatementFn,
): Promise<ExecResult> {
  // An unredirected group uses the live table itself. Its own redirections
  // create a temporary override table which withChannels restores afterward.
  const compiled: CompiledOutputRedirections =
    node.redirections.length === 0
      ? {
          channels: ctx.outputChannels,
          legacyRedirections: [],
        }
      : await compileOutputRedirections(
          ctx,
          ctx.outputChannels,
          node.redirections,
        );
  if (compiled.error) {
    return withChannels(ctx, compiled.channels, () =>
      executeAndPumpResult(ctx, () =>
        Promise.resolve(compiled.error as ExecResult),
      ),
    );
  }

  return withChannels(ctx, compiled.channels, async () => {
    const savedGroupStdin = ctx.state.groupStdin;
    try {
      // The channel compiler leaves input redirects on the legacy path.
      const fdVarError = await processFdVariableRedirections(
        ctx,
        compiled.legacyRedirections,
      );
      if (fdVarError) {
        return await executeAndPumpResult(ctx, () =>
          Promise.resolve(fdVarError),
        );
      }

      // Process heredoc and input redirections to get stdin content.
      const incomingStdinBytes = await collectBytes(stdin);
      let effectiveStdin: ByteStream = fromBytes(incomingStdinBytes);
      let redirSetStdin = false;
      for (const redir of compiled.legacyRedirections) {
        if (redir.fdVariable) {
          continue;
        }

        if (
          (redir.operator === "<<" || redir.operator === "<<-") &&
          redir.target.type === "HereDoc"
        ) {
          const hereDoc = redir.target as HereDocNode;
          let content = await expandWord(ctx, hereDoc.content);
          if (hereDoc.stripTabs) {
            content = content
              .split("\n")
              .map((line) => line.replace(/^\t+/, ""))
              .join("\n");
          }
          const fd = redir.fd ?? 0;
          if (fd !== 0) {
            if (!ctx.state.fileDescriptors) {
              ctx.state.fileDescriptors = new Map();
            }
            ctx.state.fileDescriptors.set(fd, content);
          } else {
            effectiveStdin = fromString(content);
            redirSetStdin = true;
          }
        } else if (redir.operator === "<<<" && redir.target.type === "Word") {
          effectiveStdin = fromString(
            `${await expandWord(ctx, redir.target as WordNode)}\n`,
          );
          redirSetStdin = true;
        } else if (redir.operator === "<" && redir.target.type === "Word") {
          const target = await expandWord(ctx, redir.target as WordNode);
          try {
            const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
            effectiveStdin = await ctx.fs.readFile(filePath);
            redirSetStdin = true;
          } catch {
            return await executeAndPumpResult(ctx, () =>
              Promise.resolve(
                failure(`bash: ${target}: No such file or directory\n`),
              ),
            );
          }
        }
      }

      if (redirSetStdin || incomingStdinBytes.length > 0) {
        ctx.state.groupStdin = effectiveStdin;
      }

      let exitCode = 0;
      for (const stmt of node.body) {
        const statementResult = await executeStatement(stmt);
        const pumpedResult = await executeAndPumpResult(ctx, () =>
          Promise.resolve(statementResult),
        );
        exitCode = pumpedResult.exitCode;
      }

      return result(emptyStream(), emptyStream(), exitCode);
    } catch (error) {
      const { diagnosticWritten, writeFailure } =
        await writeErrorDiagnosticWithWriteFailure(ctx, error);
      if (writeFailure) {
        return writeFailure;
      }
      if (
        isScopeExitError(error) ||
        error instanceof ErrexitError ||
        error instanceof ExitError ||
        error instanceof PosixFatalError ||
        error instanceof SubshellExitError ||
        error instanceof ExecutionLimitError
      ) {
        throw error;
      }
      if (!diagnosticWritten) {
        await executeAndPumpResult(ctx, () =>
          Promise.resolve(failure(`${getErrorMessage(error)}\n`)),
        );
      }
      return result(emptyStream(), emptyStream(), 1);
    } finally {
      ctx.state.groupStdin = savedGroupStdin;
    }
  });
}

/**
 * Type for executeScript callback
 */
export type ExecuteScriptFn = (node: ScriptNode) => Promise<ExecResult>;

/**
 * Execute a user script file found in PATH.
 * This handles executable files that don't have registered command handlers.
 * The script runs in a subshell-like environment with its own positional parameters.
 */
export async function executeUserScript(
  ctx: InterpreterContext,
  scriptPath: string,
  args: string[],
  stdin: ByteStream,
  executeScript: ExecuteScriptFn,
): Promise<ExecResult> {
  // Read the script content
  let content: string;
  try {
    content = await ctx.fs.readFileText(scriptPath);
  } catch {
    return failure(`bash: ${scriptPath}: No such file or directory\n`, 127);
  }

  // Check for shebang and skip it if present (we'll execute as bash script)
  // Note: we don't actually support different interpreters, just bash
  if (content.startsWith("#!")) {
    const firstNewline = content.indexOf("\n");
    if (firstNewline !== -1) {
      content = content.slice(firstNewline + 1);
    }
  }

  // Save current state for restoration after script execution
  const savedEnv = new Map(ctx.state.env);
  const savedCwd = ctx.state.cwd;
  const savedOptions = { ...ctx.state.options };
  const savedLoopDepth = ctx.state.loopDepth;
  const savedParentHasLoopContext = ctx.state.parentHasLoopContext;
  const savedLastArg = ctx.state.lastArg;
  const savedBashPid = ctx.state.bashPid;
  const savedGroupStdin = ctx.state.groupStdin;
  const savedSource = ctx.state.currentSource;

  const cleanup = (): void => {
    ctx.state.env = savedEnv;
    ctx.state.cwd = savedCwd;
    ctx.state.options = savedOptions;
    ctx.state.loopDepth = savedLoopDepth;
    ctx.state.parentHasLoopContext = savedParentHasLoopContext;
    ctx.state.lastArg = savedLastArg;
    ctx.state.bashPid = savedBashPid;
    ctx.state.groupStdin = savedGroupStdin;
    ctx.state.currentSource = savedSource;
  };

  try {
    // Set up the script's subshell-like state inside the restoration guard.
    ctx.state.parentHasLoopContext = savedLoopDepth > 0;
    ctx.state.loopDepth = 0;
    ctx.state.bashPid = ctx.state.nextVirtualPid++;

    // Materialize stdin once; only set groupStdin if there's content. A lazy
    // producer may throw here, so this must remain inside the guarded boundary.
    const stdinBytes = await collectBytes(stdin);
    if (stdinBytes.length > 0) {
      ctx.state.groupStdin = fromBytes(stdinBytes);
    }
    ctx.state.currentSource = scriptPath;

    // Set positional parameters ($1, $2, etc.) from args.
    envSet(ctx.state.env, "0", scriptPath);
    envSet(ctx.state.env, "#", String(args.length));
    envSet(ctx.state.env, "@", args.join(" "));
    envSet(ctx.state.env, "*", args.join(" "));
    for (let i = 0; i < args.length && i < 9; i++) {
      envSet(ctx.state.env, String(i + 1), args[i]);
    }
    for (let i = args.length + 1; i <= 9; i++) {
      ctx.state.env.delete(String(i));
    }

    const parser = new Parser();
    const ast = parser.parse(content);
    const execResult = await executeScript(ast);
    return await executeAndPumpResult(ctx, () => Promise.resolve(execResult));
  } catch (error) {
    const { writeFailure } = await writeErrorDiagnosticWithWriteFailure(
      ctx,
      error,
    );
    if (writeFailure) {
      return writeFailure;
    }

    // ExitError propagates after its diagnostic has reached the active table.
    if (error instanceof ExitError) {
      throw error;
    }

    // ExecutionLimitError must always propagate
    if (error instanceof ExecutionLimitError) {
      throw error;
    }

    // Handle parse errors
    if ((error as ParseException).name === "ParseException") {
      return failure(`bash: ${scriptPath}: ${(error as Error).message}\n`);
    }

    throw error;
  } finally {
    cleanup();
  }
}
