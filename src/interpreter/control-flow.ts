/**
 * Control Flow Execution
 *
 * Handles control flow constructs:
 * - if/elif/else
 * - for loops
 * - C-style for loops
 * - while loops
 * - until loops
 * - case statements
 * - break/continue
 */

import type {
  CaseNode,
  CStyleForNode,
  ForNode,
  HereDocNode,
  IfNode,
  UntilNode,
  WhileNode,
  WordNode,
} from "../ast/types.js";
import type { ExecResult } from "../types.js";
import { envGet, envSet } from "../utils/bytes.js";
import {
  type ByteStream,
  collectBytes,
  concatStreams,
  emptyStream,
  fromBytes,
  fromChunks,
  fromString,
} from "../utils/stream.js";
import { evaluateArithmetic } from "./arithmetic.js";
import { matchPattern } from "./conditionals.js";
import { BreakError, ContinueError, GlobError } from "./errors.js";
import {
  escapeGlobChars,
  expandWord,
  expandWordWithGlob,
  isWordFullyQuoted,
} from "./expansion.js";
import { executeCondition } from "./helpers/condition.js";
import { handleLoopError } from "./helpers/loop.js";
import { failure, result, throwExecutionLimit } from "./helpers/result.js";
import { executeStatements } from "./helpers/statements.js";
import { applyRedirections, preOpenOutputRedirects } from "./redirections.js";
import type { InterpreterContext } from "./types.js";

export async function executeIf(
  ctx: InterpreterContext,
  node: IfNode,
): Promise<ExecResult> {
  let stdout: ByteStream = emptyStream();
  let stderr: ByteStream = emptyStream();

  for (const clause of node.clauses) {
    // Condition evaluation should not trigger errexit
    const condResult = await executeCondition(ctx, clause.condition);
    stdout = concatStreams(stdout, condResult.stdout);
    stderr = concatStreams(stderr, condResult.stderr);

    if (condResult.exitCode === 0) {
      return executeStatements(ctx, clause.body, stdout, stderr);
    }
  }

  if (node.elseBody) {
    return executeStatements(ctx, node.elseBody, stdout, stderr);
  }

  return { stdout, stderr, exitCode: 0 };
}

export async function executeFor(
  ctx: InterpreterContext,
  node: ForNode,
): Promise<ExecResult> {
  // Pre-open output redirects to truncate files BEFORE expanding words
  // This matches bash behavior where redirect files are opened before
  // any command substitutions in the word list are evaluated
  const preOpenError = await preOpenOutputRedirects(ctx, node.redirections);
  if (preOpenError) {
    return preOpenError;
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const drainTo = async (chunks: Uint8Array[], s: ByteStream) => {
    const b = await collectBytes(s);
    if (b.length > 0) chunks.push(b);
  };
  const buildStdout = () => fromChunks(stdoutChunks);
  const buildStderr = () => fromChunks(stderrChunks);
  let exitCode = 0;
  let iterations = 0;

  // Validate variable name at runtime (matches bash behavior)
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(node.variable)) {
    return failure(`bash: \`${node.variable}': not a valid identifier\n`);
  }

  let words: string[] = [];
  if (node.words === null) {
    words = envGet(ctx.state.env, "@", "").split(" ").filter(Boolean);
  } else if (node.words.length === 0) {
    words = [];
  } else {
    try {
      for (const word of node.words) {
        const expanded = await expandWordWithGlob(ctx, word);
        words.push(...expanded.values);
      }
    } catch (e) {
      if (e instanceof GlobError) {
        // failglob: return error with exit code 1
        return { stdout: emptyStream(), stderr: e.stderr, exitCode: 1 };
      }
      throw e;
    }
  }

  ctx.state.loopDepth++;
  try {
    for (const value of words) {
      iterations++;
      if (iterations > ctx.limits.maxLoopIterations) {
        throwExecutionLimit(
          `for loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`,
          "iterations",
          buildStdout(),
          buildStderr(),
        );
      }

      envSet(ctx.state.env, node.variable, value);

      try {
        for (const stmt of node.body) {
          const stmtResult = await ctx.executeStatement(stmt);
          await drainTo(stdoutChunks, stmtResult.stdout);
          await drainTo(stderrChunks, stmtResult.stderr);
          exitCode = stmtResult.exitCode;
        }
      } catch (error) {
        // Use accumulated chunks as the input stream to handleLoopError,
        // which merges them with any output carried by the error itself.
        // After this, the chunks array is "logically empty" — any further
        // accumulation continues from the merged stream(s).
        const loopResult = handleLoopError(
          error,
          buildStdout(),
          buildStderr(),
          ctx.state.loopDepth,
        );
        stdoutChunks.length = 0;
        stderrChunks.length = 0;
        if (loopResult.action === "break") {
          await drainTo(stdoutChunks, loopResult.stdout);
          await drainTo(stderrChunks, loopResult.stderr);
          break;
        }
        if (loopResult.action === "continue") {
          await drainTo(stdoutChunks, loopResult.stdout);
          await drainTo(stderrChunks, loopResult.stderr);
          continue;
        }
        if (loopResult.action === "error") {
          const bodyResult = result(
            loopResult.stdout,
            loopResult.stderr,
            loopResult.exitCode ?? 1,
          );
          return applyRedirections(ctx, bodyResult, node.redirections);
        }
        // rethrow: error.stdout/stderr already merged by prependOutput
        throw loopResult.error;
      }
    }
  } finally {
    ctx.state.loopDepth--;
  }

  const bodyResult = result(buildStdout(), buildStderr(), exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}

export async function executeCStyleFor(
  ctx: InterpreterContext,
  node: CStyleForNode,
): Promise<ExecResult> {
  // Pre-open output redirects to truncate files BEFORE evaluating expressions
  // This matches bash behavior where redirect files are opened before
  // any command substitutions in the loop are evaluated
  const preOpenError = await preOpenOutputRedirects(ctx, node.redirections);
  if (preOpenError) {
    return preOpenError;
  }

  // Update currentLine for $LINENO - set to loop header line
  const loopLine = node.line;
  if (loopLine !== undefined) {
    ctx.state.currentLine = loopLine;
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const drainTo = async (chunks: Uint8Array[], s: ByteStream) => {
    const b = await collectBytes(s);
    if (b.length > 0) chunks.push(b);
  };
  const buildStdout = () => fromChunks(stdoutChunks);
  const buildStderr = () => fromChunks(stderrChunks);
  let exitCode = 0;
  let iterations = 0;

  if (node.init) {
    await evaluateArithmetic(ctx, node.init.expression);
  }

  ctx.state.loopDepth++;
  try {
    while (true) {
      iterations++;
      if (iterations > ctx.limits.maxLoopIterations) {
        throwExecutionLimit(
          `for loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`,
          "iterations",
          buildStdout(),
          buildStderr(),
        );
      }

      if (node.condition) {
        // Set LINENO to loop header line for condition evaluation
        if (loopLine !== undefined) {
          ctx.state.currentLine = loopLine;
        }
        const condResult = await evaluateArithmetic(
          ctx,
          node.condition.expression,
        );
        if (condResult === 0) break;
      }

      try {
        for (const stmt of node.body) {
          const stmtResult = await ctx.executeStatement(stmt);
          await drainTo(stdoutChunks, stmtResult.stdout);
          await drainTo(stderrChunks, stmtResult.stderr);
          exitCode = stmtResult.exitCode;
        }
      } catch (error) {
        const loopResult = handleLoopError(
          error,
          buildStdout(),
          buildStderr(),
          ctx.state.loopDepth,
        );
        stdoutChunks.length = 0;
        stderrChunks.length = 0;
        if (loopResult.action === "break") {
          await drainTo(stdoutChunks, loopResult.stdout);
          await drainTo(stderrChunks, loopResult.stderr);
          break;
        }
        if (loopResult.action === "continue") {
          await drainTo(stdoutChunks, loopResult.stdout);
          await drainTo(stderrChunks, loopResult.stderr);
          if (node.update) {
            await evaluateArithmetic(ctx, node.update.expression);
          }
          continue;
        }
        if (loopResult.action === "error") {
          const bodyResult = result(
            loopResult.stdout,
            loopResult.stderr,
            loopResult.exitCode ?? 1,
          );
          return applyRedirections(ctx, bodyResult, node.redirections);
        }
        throw loopResult.error;
      }

      if (node.update) {
        await evaluateArithmetic(ctx, node.update.expression);
      }
    }
  } finally {
    ctx.state.loopDepth--;
  }

  const bodyResult = result(buildStdout(), buildStderr(), exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}

export async function executeWhile(
  ctx: InterpreterContext,
  node: WhileNode,
  stdin: ByteStream = emptyStream(),
): Promise<ExecResult> {
  // Accumulate stdout/stderr as a chunks array to avoid building a deeply
  // nested concatStreams chain (one layer per iteration would make even
  // hitting the iteration limit pathologically slow).
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const drainTo = async (chunks: Uint8Array[], s: ByteStream) => {
    const bytes = await collectBytes(s);
    if (bytes.length > 0) chunks.push(bytes);
  };
  const buildStdout = () => fromChunks(stdoutChunks);
  const buildStderr = () => fromChunks(stderrChunks);
  let exitCode = 0;
  let iterations = 0;

  // Process here-doc redirections to get stdin content
  let effectiveStdin: ByteStream = stdin;
  let hasRedirStdin = false;
  for (const redir of node.redirections) {
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
      effectiveStdin = fromString(content);
      hasRedirStdin = true;
    } else if (redir.operator === "<<<" && redir.target.type === "Word") {
      effectiveStdin = fromString(
        `${await expandWord(ctx, redir.target as WordNode)}\n`,
      );
      hasRedirStdin = true;
    } else if (redir.operator === "<" && redir.target.type === "Word") {
      try {
        const target = await expandWord(ctx, redir.target as WordNode);
        const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
        effectiveStdin = await ctx.fs.readFile(filePath);
        hasRedirStdin = true;
      } catch {
        const target = await expandWord(ctx, redir.target as WordNode);
        return failure(`bash: ${target}: No such file or directory\n`);
      }
    }
  }

  // Save and set groupStdin for piped while loops. `read` in the body
  // and condition reads from groupStdin, which must reflect either the
  // explicit redirection or the pipeline stdin we received.
  const savedGroupStdin = ctx.state.groupStdin;
  if (hasRedirStdin) {
    ctx.state.groupStdin = effectiveStdin;
  } else {
    // Materialize pipeline stdin once so the read builtin can carve lines
    // off it across loop iterations without losing data (streams are
    // single-use). Empty pipelines leave groupStdin untouched.
    const stdinBytes = await collectBytes(stdin);
    if (stdinBytes.length > 0) {
      ctx.state.groupStdin = fromBytes(stdinBytes);
    }
  }

  ctx.state.loopDepth++;
  try {
    while (true) {
      iterations++;
      if (iterations > ctx.limits.maxLoopIterations) {
        throwExecutionLimit(
          `while loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`,
          "iterations",
          buildStdout(),
          buildStderr(),
        );
      }

      let conditionExitCode = 0;
      let shouldBreak = false;
      let shouldContinue = false;

      // Condition evaluation should not trigger errexit
      const savedInCondition = ctx.state.inCondition;
      ctx.state.inCondition = true;
      try {
        for (const stmt of node.condition) {
          const stmtResult = await ctx.executeStatement(stmt);
          await drainTo(stdoutChunks, stmtResult.stdout);
          await drainTo(stderrChunks, stmtResult.stderr);
          conditionExitCode = stmtResult.exitCode;
        }
      } catch (error) {
        // break/continue in condition should affect THIS while loop
        if (error instanceof BreakError) {
          await drainTo(stdoutChunks, error.stdout);
          await drainTo(stderrChunks, error.stderr);
          if (error.levels > 1 && ctx.state.loopDepth > 1) {
            error.levels--;
            error.stdout = buildStdout();
            error.stderr = buildStderr();
            ctx.state.inCondition = savedInCondition;
            throw error;
          }
          shouldBreak = true;
        } else if (error instanceof ContinueError) {
          await drainTo(stdoutChunks, error.stdout);
          await drainTo(stderrChunks, error.stderr);
          if (error.levels > 1 && ctx.state.loopDepth > 1) {
            error.levels--;
            error.stdout = buildStdout();
            error.stderr = buildStderr();
            ctx.state.inCondition = savedInCondition;
            throw error;
          }
          shouldContinue = true;
        } else {
          ctx.state.inCondition = savedInCondition;
          throw error;
        }
      } finally {
        ctx.state.inCondition = savedInCondition;
      }

      if (shouldBreak) break;
      if (shouldContinue) continue;
      if (conditionExitCode !== 0) break;

      try {
        for (const stmt of node.body) {
          const stmtResult = await ctx.executeStatement(stmt);
          await drainTo(stdoutChunks, stmtResult.stdout);
          await drainTo(stderrChunks, stmtResult.stderr);
          exitCode = stmtResult.exitCode;
        }
      } catch (error) {
        const loopResult = handleLoopError(
          error,
          buildStdout(),
          buildStderr(),
          ctx.state.loopDepth,
        );
        stdoutChunks.length = 0;
        stderrChunks.length = 0;
        if (loopResult.action === "break") {
          await drainTo(stdoutChunks, loopResult.stdout);
          await drainTo(stderrChunks, loopResult.stderr);
          break;
        }
        if (loopResult.action === "continue") {
          await drainTo(stdoutChunks, loopResult.stdout);
          await drainTo(stderrChunks, loopResult.stderr);
          continue;
        }
        if (loopResult.action === "error") {
          return result(
            loopResult.stdout,
            loopResult.stderr,
            loopResult.exitCode ?? 1,
          );
        }
        throw loopResult.error;
      }
    }
  } finally {
    ctx.state.loopDepth--;
    ctx.state.groupStdin = savedGroupStdin;
  }

  return result(buildStdout(), buildStderr(), exitCode);
}

export async function executeUntil(
  ctx: InterpreterContext,
  node: UntilNode,
): Promise<ExecResult> {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const drainTo = async (chunks: Uint8Array[], s: ByteStream) => {
    const b = await collectBytes(s);
    if (b.length > 0) chunks.push(b);
  };
  const buildStdout = () => fromChunks(stdoutChunks);
  const buildStderr = () => fromChunks(stderrChunks);
  let exitCode = 0;
  let iterations = 0;

  ctx.state.loopDepth++;
  try {
    while (true) {
      iterations++;
      if (iterations > ctx.limits.maxLoopIterations) {
        throwExecutionLimit(
          `until loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`,
          "iterations",
          buildStdout(),
          buildStderr(),
        );
      }

      const condResult = await executeCondition(ctx, node.condition);
      await drainTo(stdoutChunks, condResult.stdout);
      await drainTo(stderrChunks, condResult.stderr);

      if (condResult.exitCode === 0) break;

      try {
        for (const stmt of node.body) {
          const stmtResult = await ctx.executeStatement(stmt);
          await drainTo(stdoutChunks, stmtResult.stdout);
          await drainTo(stderrChunks, stmtResult.stderr);
          exitCode = stmtResult.exitCode;
        }
      } catch (error) {
        const loopResult = handleLoopError(
          error,
          buildStdout(),
          buildStderr(),
          ctx.state.loopDepth,
        );
        stdoutChunks.length = 0;
        stderrChunks.length = 0;
        if (loopResult.action === "break") {
          await drainTo(stdoutChunks, loopResult.stdout);
          await drainTo(stderrChunks, loopResult.stderr);
          break;
        }
        if (loopResult.action === "continue") {
          await drainTo(stdoutChunks, loopResult.stdout);
          await drainTo(stderrChunks, loopResult.stderr);
          continue;
        }
        if (loopResult.action === "error") {
          return result(
            loopResult.stdout,
            loopResult.stderr,
            loopResult.exitCode ?? 1,
          );
        }
        throw loopResult.error;
      }
    }
  } finally {
    ctx.state.loopDepth--;
  }

  return result(buildStdout(), buildStderr(), exitCode);
}

export async function executeCase(
  ctx: InterpreterContext,
  node: CaseNode,
): Promise<ExecResult> {
  // Pre-open output redirects to truncate files BEFORE expanding case word
  // This matches bash behavior where redirect files are opened before
  // any command substitutions in the case word are evaluated
  const preOpenError = await preOpenOutputRedirects(ctx, node.redirections);
  if (preOpenError) {
    return preOpenError;
  }

  let stdout: ByteStream = emptyStream();
  let stderr: ByteStream = emptyStream();
  let exitCode = 0;

  const value = await expandWord(ctx, node.word);

  // fallThrough tracks whether we should execute the next case body unconditionally
  // This happens when the previous case ended with ;& (unconditional fall-through)
  let fallThrough = false;

  for (let i = 0; i < node.items.length; i++) {
    const item = node.items[i];
    let matched = fallThrough; // If falling through, automatically match

    if (!fallThrough) {
      // Normal pattern matching
      for (const pattern of item.patterns) {
        let patternStr = await expandWord(ctx, pattern);
        // If the pattern is fully quoted, escape glob characters for literal matching
        if (isWordFullyQuoted(pattern)) {
          patternStr = escapeGlobChars(patternStr);
        }
        const nocasematch = ctx.state.shoptOptions.nocasematch;
        const extglob = ctx.state.shoptOptions.extglob;
        if (matchPattern(value, patternStr, nocasematch, extglob)) {
          matched = true;
          break;
        }
      }
    }

    if (matched) {
      const bodyResult = await executeStatements(
        ctx,
        item.body,
        stdout,
        stderr,
      );
      stdout = bodyResult.stdout;
      stderr = bodyResult.stderr;
      exitCode = bodyResult.exitCode;

      // Handle different terminators:
      // ;; - stop, no fall-through
      // ;& - unconditional fall-through (execute next body without pattern check)
      // ;;& - continue pattern matching (check next case patterns)
      if (item.terminator === ";;") {
        break;
      } else if (item.terminator === ";&") {
        fallThrough = true;
      } else {
        // ;;& - reset fallThrough, continue to next iteration for pattern matching
        fallThrough = false;
      }
    } else {
      fallThrough = false;
    }
  }

  // Apply output redirections
  const bodyResult = result(stdout, stderr, exitCode);
  return applyRedirections(ctx, bodyResult, node.redirections);
}
