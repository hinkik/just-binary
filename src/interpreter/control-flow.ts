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
  RedirectionNode,
  UntilNode,
  WhileNode,
  WordNode,
} from "../ast/types.js";
import type { ExecResult } from "../types.js";
import { envGet, envSet } from "../utils/bytes.js";
import {
  type ByteStream,
  collectBytes,
  emptyStream,
  fromBytes,
  fromString,
} from "../utils/stream.js";
import { evaluateArithmetic } from "./arithmetic.js";
import { matchPattern } from "./conditionals.js";
import {
  AbortExecutionError,
  BreakError,
  ContinueError,
  GlobError,
} from "./errors.js";
import {
  escapeGlobChars,
  expandWord,
  expandWordWithGlob,
  isWordFullyQuoted,
} from "./expansion.js";
import { executeCondition } from "./helpers/condition.js";
import { getErrorMessage } from "./helpers/errors.js";
import { handleLoopError } from "./helpers/loop.js";
import { failure, throwExecutionLimit } from "./helpers/result.js";
import { executeStatements } from "./helpers/statements.js";
import { traceSimpleCommand } from "./helpers/xtrace.js";
import {
  pumpErrorStreams,
  pumpResult,
  withChannels,
  writeToChannel,
} from "./output-channels.js";
import { compileOutputRedirections } from "./redirect-channels.js";
import type { InterpreterContext } from "./types.js";

function errorLine(error: unknown): string {
  const message = getErrorMessage(error);
  return message.endsWith("\n") ? message : `${message}\n`;
}

async function executeWithCompoundRedirections(
  ctx: InterpreterContext,
  redirections: RedirectionNode[],
  execute: (legacyRedirections: RedirectionNode[]) => Promise<number>,
): Promise<ExecResult> {
  const compiled = await compileOutputRedirections(
    ctx,
    ctx.outputChannels,
    redirections,
  );
  if (compiled.error) {
    return withChannels(ctx, compiled.channels, () =>
      pumpResult(ctx, compiled.error as ExecResult),
    );
  }

  return withChannels(ctx, compiled.channels, async () => {
    try {
      const exitCode = await execute(compiled.legacyRedirections);
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
        exitCode,
      };
    } catch (error) {
      const carriedOutput = await pumpErrorStreams(ctx, error);
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOSPC"
      ) {
        if (!carriedOutput) {
          return await pumpResult(ctx, failure(errorLine(error)));
        }
        return {
          stdout: emptyStream(),
          stderr: emptyStream(),
          exitCode: 1,
        };
      }
      throw error;
    }
  });
}

export async function executeIf(
  ctx: InterpreterContext,
  node: IfNode,
): Promise<ExecResult> {
  return executeWithCompoundRedirections(ctx, node.redirections, async () => {
    for (const clause of node.clauses) {
      const condResult = await executeCondition(ctx, clause.condition);
      if (condResult.exitCode === 0) {
        const bodyResult = await executeStatements(ctx, clause.body);
        return bodyResult.exitCode;
      }
    }

    if (node.elseBody) {
      const bodyResult = await executeStatements(ctx, node.elseBody);
      return bodyResult.exitCode;
    }
    return 0;
  });
}

export async function executeFor(
  ctx: InterpreterContext,
  node: ForNode,
): Promise<ExecResult> {
  return executeWithCompoundRedirections(ctx, node.redirections, async () => {
    let exitCode = 0;
    let iterations = 0;

    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(node.variable)) {
      await pumpResult(
        ctx,
        failure(`bash: \`${node.variable}': not a valid identifier\n`),
      );
      return 1;
    }

    let words: string[] = [];
    if (node.words === null) {
      words = envGet(ctx.state.env, "@", "").split(" ").filter(Boolean);
    } else if (node.words.length > 0) {
      try {
        for (const word of node.words) {
          const expanded = await expandWordWithGlob(ctx, word);
          words.push(...expanded.values);
        }
      } catch (error) {
        if (error instanceof GlobError) {
          await pumpErrorStreams(ctx, error);
          return 1;
        }
        throw error;
      }
    }

    ctx.state.loopDepth++;
    try {
      for (const value of words) {
        iterations++;
        if (ctx.signal?.aborted) {
          throw new AbortExecutionError(ctx.signal.reason);
        }
        if (iterations > ctx.limits.maxLoopIterations) {
          throwExecutionLimit(
            `for loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`,
            "iterations",
          );
        }

        envSet(ctx.state.env, node.variable, value);
        await writeToChannel(
          ctx,
          2,
          await traceSimpleCommand(ctx, "for", [node.variable, "in", ...words]),
        );

        try {
          for (const stmt of node.body) {
            const stmtResult = await ctx.executeStatement(stmt);
            await pumpResult(ctx, stmtResult);
            exitCode = stmtResult.exitCode;
          }
        } catch (error) {
          const carriedOutput = await pumpErrorStreams(ctx, error);
          const loopResult = handleLoopError(error, ctx.state.loopDepth);
          if (loopResult.action === "break") {
            break;
          }
          if (loopResult.action === "continue") {
            continue;
          }
          if (loopResult.action === "error") {
            if (!carriedOutput) {
              await pumpResult(ctx, failure(errorLine(loopResult.error)));
            }
            return loopResult.exitCode ?? 1;
          }
          throw loopResult.error;
        }
      }
    } finally {
      ctx.state.loopDepth--;
    }

    return exitCode;
  });
}

export async function executeCStyleFor(
  ctx: InterpreterContext,
  node: CStyleForNode,
): Promise<ExecResult> {
  return executeWithCompoundRedirections(ctx, node.redirections, async () => {
    const loopLine = node.line;
    if (loopLine !== undefined) {
      ctx.state.currentLine = loopLine;
    }

    let exitCode = 0;
    let iterations = 0;

    if (node.init) {
      await evaluateArithmetic(ctx, node.init.expression);
    }

    ctx.state.loopDepth++;
    try {
      while (true) {
        iterations++;
        if (ctx.signal?.aborted) {
          throw new AbortExecutionError(ctx.signal.reason);
        }
        if (iterations > ctx.limits.maxLoopIterations) {
          throwExecutionLimit(
            `for loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`,
            "iterations",
          );
        }

        if (node.condition) {
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
            await pumpResult(ctx, stmtResult);
            exitCode = stmtResult.exitCode;
          }
        } catch (error) {
          const carriedOutput = await pumpErrorStreams(ctx, error);
          const loopResult = handleLoopError(error, ctx.state.loopDepth);
          if (loopResult.action === "break") {
            break;
          }
          if (loopResult.action === "continue") {
            if (node.update) {
              await evaluateArithmetic(ctx, node.update.expression);
            }
            continue;
          }
          if (loopResult.action === "error") {
            if (!carriedOutput) {
              await pumpResult(ctx, failure(errorLine(loopResult.error)));
            }
            return loopResult.exitCode ?? 1;
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

    return exitCode;
  });
}

export async function executeWhile(
  ctx: InterpreterContext,
  node: WhileNode,
  stdin: ByteStream = emptyStream(),
): Promise<ExecResult> {
  return executeWithCompoundRedirections(
    ctx,
    node.redirections,
    async (legacyRedirections) => {
      let exitCode = 0;
      let iterations = 0;
      let effectiveStdin: ByteStream = stdin;
      let hasRedirStdin = false;

      for (const redir of legacyRedirections) {
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
          const target = await expandWord(ctx, redir.target as WordNode);
          try {
            const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
            effectiveStdin = await ctx.fs.readFile(filePath);
            hasRedirStdin = true;
          } catch {
            await pumpResult(
              ctx,
              failure(`bash: ${target}: No such file or directory\n`),
            );
            return 1;
          }
        }
      }

      const savedGroupStdin = ctx.state.groupStdin;
      if (hasRedirStdin) {
        ctx.state.groupStdin = effectiveStdin;
      } else {
        const stdinBytes = await collectBytes(stdin);
        if (stdinBytes.length > 0) {
          ctx.state.groupStdin = fromBytes(stdinBytes);
        }
      }

      ctx.state.loopDepth++;
      try {
        while (true) {
          iterations++;
          if (ctx.signal?.aborted) {
            throw new AbortExecutionError(ctx.signal.reason);
          }
          if (iterations > ctx.limits.maxLoopIterations) {
            throwExecutionLimit(
              `while loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`,
              "iterations",
            );
          }

          let conditionExitCode = 0;
          let shouldBreak = false;
          let shouldContinue = false;

          try {
            conditionExitCode = (await executeCondition(ctx, node.condition))
              .exitCode;
          } catch (error) {
            await pumpErrorStreams(ctx, error);
            if (error instanceof BreakError) {
              if (error.levels > 1 && ctx.state.loopDepth > 1) {
                error.levels--;
                throw error;
              }
              shouldBreak = true;
            } else if (error instanceof ContinueError) {
              if (error.levels > 1 && ctx.state.loopDepth > 1) {
                error.levels--;
                throw error;
              }
              shouldContinue = true;
            } else {
              throw error;
            }
          }

          if (shouldBreak) break;
          if (shouldContinue) continue;
          if (conditionExitCode !== 0) break;

          try {
            for (const stmt of node.body) {
              const stmtResult = await ctx.executeStatement(stmt);
              await pumpResult(ctx, stmtResult);
              exitCode = stmtResult.exitCode;
            }
          } catch (error) {
            const carriedOutput = await pumpErrorStreams(ctx, error);
            const loopResult = handleLoopError(error, ctx.state.loopDepth);
            if (loopResult.action === "break") {
              break;
            }
            if (loopResult.action === "continue") {
              continue;
            }
            if (loopResult.action === "error") {
              if (!carriedOutput) {
                await pumpResult(ctx, failure(errorLine(loopResult.error)));
              }
              return loopResult.exitCode ?? 1;
            }
            throw loopResult.error;
          }
        }
      } finally {
        ctx.state.loopDepth--;
        ctx.state.groupStdin = savedGroupStdin;
      }

      return exitCode;
    },
  );
}

export async function executeUntil(
  ctx: InterpreterContext,
  node: UntilNode,
): Promise<ExecResult> {
  return executeWithCompoundRedirections(ctx, node.redirections, async () => {
    let exitCode = 0;
    let iterations = 0;

    ctx.state.loopDepth++;
    try {
      while (true) {
        iterations++;
        if (ctx.signal?.aborted) {
          throw new AbortExecutionError(ctx.signal.reason);
        }
        if (iterations > ctx.limits.maxLoopIterations) {
          throwExecutionLimit(
            `until loop: too many iterations (${ctx.limits.maxLoopIterations}), increase executionLimits.maxLoopIterations`,
            "iterations",
          );
        }

        const condResult = await executeCondition(ctx, node.condition);
        if (condResult.exitCode === 0) break;

        try {
          for (const stmt of node.body) {
            const stmtResult = await ctx.executeStatement(stmt);
            await pumpResult(ctx, stmtResult);
            exitCode = stmtResult.exitCode;
          }
        } catch (error) {
          const carriedOutput = await pumpErrorStreams(ctx, error);
          const loopResult = handleLoopError(error, ctx.state.loopDepth);
          if (loopResult.action === "break") {
            break;
          }
          if (loopResult.action === "continue") {
            continue;
          }
          if (loopResult.action === "error") {
            if (!carriedOutput) {
              await pumpResult(ctx, failure(errorLine(loopResult.error)));
            }
            return loopResult.exitCode ?? 1;
          }
          throw loopResult.error;
        }
      }
    } finally {
      ctx.state.loopDepth--;
    }

    return exitCode;
  });
}

export async function executeCase(
  ctx: InterpreterContext,
  node: CaseNode,
): Promise<ExecResult> {
  return executeWithCompoundRedirections(ctx, node.redirections, async () => {
    let exitCode = 0;
    const value = await expandWord(ctx, node.word);
    let fallThrough = false;

    for (let i = 0; i < node.items.length; i++) {
      const item = node.items[i];
      let matched = fallThrough;

      if (!fallThrough) {
        for (const pattern of item.patterns) {
          let patternStr = await expandWord(ctx, pattern);
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
        const bodyResult = await executeStatements(ctx, item.body);
        exitCode = bodyResult.exitCode;

        if (item.terminator === ";;") {
          break;
        } else if (item.terminator === ";&") {
          fallThrough = true;
        } else {
          fallThrough = false;
        }
      } else {
        fallThrough = false;
      }
    }

    return exitCode;
  });
}
