/**
 * Function Handling
 *
 * Handles shell function definition and invocation:
 * - Function definition (adding to function table)
 * - Function calls (with positional parameters and local scopes)
 */

import type {
  FunctionDefNode,
  HereDocNode,
  RedirectionNode,
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
import { clearLocalVarStackForScope } from "./builtins/variable-assignment.js";
import { ExitError, ReturnError } from "./errors.js";
import { expandWord } from "./expansion.js";
import { ok, result, throwExecutionLimit } from "./helpers/result.js";
import { POSIX_SPECIAL_BUILTINS } from "./helpers/shell-constants.js";
import {
  executeAndPumpResult,
  pumpErrorStreams,
  pumpErrorStreamsWithWriteFailure,
  withChannels,
} from "./output-channels.js";
import { compileOutputRedirections } from "./redirect-channels.js";
import { processFdVariableRedirections } from "./redirections.js";
import type { InterpreterContext } from "./types.js";

export function executeFunctionDef(
  ctx: InterpreterContext,
  node: FunctionDefNode,
): ExecResult {
  // In POSIX mode, special built-ins cannot be redefined as functions
  // This is a fatal error that exits the script
  if (ctx.state.options.posix && POSIX_SPECIAL_BUILTINS.has(node.name)) {
    const stderr = `bash: line ${ctx.state.currentLine}: \`${node.name}': is a special builtin\n`;
    throw new ExitError(2, emptyStream(), fromString(stderr));
  }
  // Store the source file where this function is defined (for BASH_SOURCE)
  // Use currentSource from state, or the node's sourceFile, or "main" as default
  const funcWithSource: FunctionDefNode = {
    ...node,
    sourceFile: node.sourceFile ?? ctx.state.currentSource ?? "main",
  };
  ctx.state.functions.set(node.name, funcWithSource);
  return ok();
}

/**
 * Process input redirections to get stdin content for function calls.
 * Handles heredocs (<<, <<-), here-strings (<<<), and file input (<).
 */
async function processInputRedirections(
  ctx: InterpreterContext,
  redirections: RedirectionNode[],
): Promise<ByteStream> {
  let stdin: ByteStream = emptyStream();
  let hasStdin = false;

  for (const redir of redirections) {
    if (redir.fdVariable) {
      continue;
    }

    if (
      (redir.operator === "<<" || redir.operator === "<<-") &&
      redir.target.type === "HereDoc"
    ) {
      const hereDoc = redir.target as HereDocNode;
      let content = await expandWord(ctx, hereDoc.content);
      // <<- strips leading tabs from each line
      if (hereDoc.stripTabs) {
        content = content
          .split("\n")
          .map((line) => line.replace(/^\t+/, ""))
          .join("\n");
      }
      // Only handle fd 0 (stdin) for now
      const fd = redir.fd ?? 0;
      if (fd === 0) {
        stdin = fromString(content);
        hasStdin = true;
      }
    } else if (redir.operator === "<<<" && redir.target.type === "Word") {
      stdin = fromString(
        `${await expandWord(ctx, redir.target as WordNode)}\n`,
      );
      hasStdin = true;
    } else if (redir.operator === "<" && redir.target.type === "Word") {
      const target = await expandWord(ctx, redir.target as WordNode);
      const filePath = ctx.fs.resolvePath(ctx.state.cwd, target);
      try {
        stdin = await ctx.fs.readFile(filePath);
        hasStdin = true;
      } catch {
        // File not found - stdin remains unchanged
      }
    }
  }

  // Tag whether we actually set anything via a marker — caller checks size
  void hasStdin;
  return stdin;
}

export async function callFunction(
  ctx: InterpreterContext,
  func: FunctionDefNode,
  args: string[],
  stdin: ByteStream = emptyStream(),
  callLine?: number,
): Promise<ExecResult> {
  ctx.state.callDepth++;
  if (ctx.state.callDepth > ctx.limits.maxCallDepth) {
    ctx.state.callDepth--;
    throwExecutionLimit(
      `${func.name}: maximum recursion depth (${ctx.limits.maxCallDepth}) exceeded, increase executionLimits.maxCallDepth`,
      "recursion",
    );
  }

  // Track call stack for FUNCNAME, BASH_LINENO, and BASH_SOURCE
  // Initialize stacks if not present
  if (!ctx.state.funcNameStack) {
    ctx.state.funcNameStack = [];
  }
  if (!ctx.state.callLineStack) {
    ctx.state.callLineStack = [];
  }
  if (!ctx.state.sourceStack) {
    ctx.state.sourceStack = [];
  }

  // Push the function name and the line where it was called from
  ctx.state.funcNameStack.unshift(func.name);
  // Use provided callLine, or fall back to currentLine
  ctx.state.callLineStack.unshift(callLine ?? ctx.state.currentLine);
  // Push the source file where this function was defined (for BASH_SOURCE)
  ctx.state.sourceStack.unshift(func.sourceFile ?? "main");

  ctx.state.localScopes.push(new Map());

  // Push a new set for tracking exports made in this scope
  if (!ctx.state.localExportedVars) {
    ctx.state.localExportedVars = [];
  }
  ctx.state.localExportedVars.push(new Set());

  const savedPositional = new Map<string, string | undefined>();
  for (let i = 0; i < args.length; i++) {
    savedPositional.set(String(i + 1), envGet(ctx.state.env, String(i + 1)));
    envSet(ctx.state.env, String(i + 1), args[i]);
  }
  savedPositional.set("@", envGet(ctx.state.env, "@"));
  savedPositional.set("#", envGet(ctx.state.env, "#"));
  envSet(ctx.state.env, "@", args.join(" "));
  envSet(ctx.state.env, "#", String(args.length));

  const cleanup = (): void => {
    // Get the scope index before popping (for localVarStack cleanup)
    const scopeIndex = ctx.state.localScopes.length - 1;

    const localScope = ctx.state.localScopes.pop();
    if (localScope) {
      for (const [varName, originalValue] of localScope) {
        if (originalValue === undefined) {
          ctx.state.env.delete(varName);
        } else {
          ctx.state.env.set(varName, originalValue);
        }
      }
    }

    // Clear any localVarStack entries for this scope
    clearLocalVarStackForScope(ctx, scopeIndex);

    // Clear fullyUnsetLocals entries for this scope only
    if (ctx.state.fullyUnsetLocals) {
      for (const [name, entryScope] of ctx.state.fullyUnsetLocals.entries()) {
        if (entryScope === scopeIndex) {
          ctx.state.fullyUnsetLocals.delete(name);
        }
      }
    }

    // Pop local export tracking and restore export state
    // If a variable was exported only in this scope, unmark it
    if (ctx.state.localExportedVars && ctx.state.localExportedVars.length > 0) {
      const localExports = ctx.state.localExportedVars.pop();
      if (localExports) {
        for (const name of localExports) {
          // Remove the export attribute since the local scope is gone
          ctx.state.exportedVars?.delete(name);
        }
      }
    }

    for (const [key, value] of savedPositional) {
      if (value === undefined) {
        ctx.state.env.delete(key);
      } else {
        envSet(ctx.state.env, key, value);
      }
    }

    // Pop from call stack tracking
    ctx.state.funcNameStack?.shift();
    ctx.state.callLineStack?.shift();
    ctx.state.sourceStack?.shift();

    ctx.state.callDepth--;
  };

  try {
    // Function-definition redirections are evaluated at call time. Compile
    // output redirects before entering the body so bytes flow directly to the
    // selected sinks instead of being collected and redirected afterwards.
    const compiled = await compileOutputRedirections(
      ctx,
      ctx.outputChannels,
      func.redirections,
    );

    if (compiled.error) {
      return await withChannels(ctx, compiled.channels, () =>
        executeAndPumpResult(ctx, () =>
          Promise.resolve(compiled.error as ExecResult),
        ),
      );
    }

    return await withChannels(ctx, compiled.channels, async () => {
      try {
        const fdVarError = await processFdVariableRedirections(
          ctx,
          compiled.legacyRedirections,
        );
        if (fdVarError) {
          return await executeAndPumpResult(ctx, () =>
            Promise.resolve(fdVarError),
          );
        }

        // Materialize pipeline input under the function-definition redirect
        // table. A lazy producer can throw while being drained, and any output
        // carried by that error belongs to the redirected function call.
        const pipelineBytes = await collectBytes(stdin);
        const effectiveStdin =
          pipelineBytes.length > 0
            ? fromBytes(pipelineBytes)
            : await processInputRedirections(ctx, compiled.legacyRedirections);

        const execResult = await ctx.executeCommand(func.body, effectiveStdin);
        return await executeAndPumpResult(ctx, () =>
          Promise.resolve(execResult),
        );
      } catch (error) {
        // Converted children already write to the live table. Legacy children
        // may still attach streams to control-flow errors, so drain and blank
        // them before handling or propagating the error.
        const { writeFailure } = await pumpErrorStreamsWithWriteFailure(
          ctx,
          error,
        );
        if (writeFailure) {
          return writeFailure;
        }
        if (error instanceof ReturnError) {
          return result(emptyStream(), emptyStream(), error.exitCode);
        }
        throw error;
      }
    });
  } catch (error) {
    // Redirect compilation can throw before the call-local table is installed.
    // Errors from inside the table have already been drained and blanked.
    await pumpErrorStreams(ctx, error);
    throw error;
  } finally {
    cleanup();
  }
}
