/**
 * Interpreter - AST Execution Engine
 *
 * Main interpreter class that executes bash AST nodes.
 * Delegates to specialized modules for:
 * - Word expansion (expansion.ts)
 * - Arithmetic evaluation (arithmetic.ts)
 * - Conditional evaluation (conditionals.ts)
 * - Built-in commands (builtins.ts)
 * - Redirections (redirections.ts)
 */

import type {
  ArithmeticCommandNode,
  CommandNode,
  ConditionalCommandNode,
  GroupNode,
  HereDocNode,
  PipelineNode,
  ScriptNode,
  SimpleCommandNode,
  StatementNode,
  SubshellNode,
  WordNode,
} from "../ast/types.js";
import type { IFileSystem } from "../fs/interface.js";
import { mapToRecord } from "../helpers/env.js";
import type { ExecutionLimits } from "../limits.js";
import type { SecureFetch } from "../network/index.js";
import { ParseException } from "../parser/types.js";
import type {
  CommandRegistry,
  ExecResult,
  FeatureCoverageWriter,
  TraceCallback,
} from "../types.js";
import {
  concat,
  decode,
  decodeArgs,
  encode,
  envGet,
  envSet,
} from "../utils/bytes.js";
import {
  type ByteStream,
  collectBytes,
  concatStreams,
  emptyStream,
  fromBytes,
  fromString,
} from "../utils/stream.js";
import { expandAlias as expandAliasHelper } from "./alias-expansion.js";
import { evaluateArithmetic } from "./arithmetic.js";
import {
  expandLocalArrayAssignment as expandLocalArrayAssignmentHelper,
  expandScalarAssignmentArg as expandScalarAssignmentArgHelper,
} from "./assignment-expansion.js";
import {
  type BuiltinDispatchContext,
  dispatchBuiltin,
  executeExternalCommand,
} from "./builtin-dispatch.js";
import { findCommandInPath as findCommandInPathHelper } from "./command-resolution.js";
import { evaluateConditional } from "./conditionals.js";
import {
  executeCase,
  executeCStyleFor,
  executeFor,
  executeIf,
  executeUntil,
  executeWhile,
} from "./control-flow.js";
import {
  ArithmeticError,
  BadSubstitutionError,
  BraceExpansionError,
  BreakError,
  ContinueError,
  ErrexitError,
  ExecutionLimitError,
  ExitError,
  GlobError,
  NounsetError,
  PosixFatalError,
  ReturnError,
} from "./errors.js";
import {
  expandWord,
  expandWordToBytes,
  expandWordWithGlob,
} from "./expansion.js";
import { executeFunctionDef } from "./functions.js";
import { isNameref, resolveNameref } from "./helpers/nameref.js";
import {
  failure,
  ok,
  testResult,
  throwExecutionLimit,
} from "./helpers/result.js";
import { isPosixSpecialBuiltin } from "./helpers/shell-constants.js";
import {
  isWordLiteralMatch,
  parseRwFdContent,
} from "./helpers/word-matching.js";
import { traceSimpleCommand } from "./helpers/xtrace.js";
import { executePipeline as executePipelineHelper } from "./pipeline-execution.js";
import {
  applyRedirections,
  preOpenOutputRedirects,
  processFdVariableRedirections,
} from "./redirections.js";
import { processAssignments } from "./simple-command-assignments.js";
import {
  executeGroup as executeGroupHelper,
  executeSubshell as executeSubshellHelper,
  executeUserScript as executeUserScriptHelper,
} from "./subshell-group.js";
import type { InterpreterContext, InterpreterState } from "./types.js";

export type { InterpreterContext, InterpreterState } from "./types.js";

/**
 * Check if a word can use the bytes expansion path (preserves non-UTF-8 data).
 * Returns true for simple words where expandWordToBytes can handle them fully:
 * - Single Bytes part (e.g., $'\xff')
 * - Single DoubleQuoted part with only literals, Bytes, and simple param expansions
 * - Concatenations of the above
 * Returns false for words that need glob expansion, word splitting, or brace expansion.
 */
function wordCanUseBytesPath(ctx: InterpreterContext, word: WordNode): boolean {
  for (const part of word.parts) {
    switch (part.type) {
      case "Bytes":
      case "Literal":
      case "SingleQuoted":
      case "Escaped":
        continue;
      case "DoubleQuoted":
        // Check inner parts are simple
        for (const inner of part.parts) {
          switch (inner.type) {
            case "Bytes":
            case "Literal":
            case "SingleQuoted":
            case "Escaped":
              continue;
            case "ParameterExpansion":
              if (inner.operation) return false; // complex ops need string path
              // $@, $*, ${arr[@]}, ${arr[*]} produce multiple values
              // and must go through expandWordWithGlob's special multi-value handling
              if (inner.parameter === "@" || inner.parameter === "*")
                return false;
              if (
                inner.parameter.endsWith("[@]") ||
                inner.parameter.endsWith("[*]")
              )
                return false;
              // Namerefs can resolve to arr[@] or arr[*], producing multiple values
              if (isNameref(ctx, inner.parameter)) {
                const target = resolveNameref(ctx, inner.parameter);
                if (
                  target &&
                  (target.endsWith("[@]") || target.endsWith("[*]"))
                )
                  return false;
              }
              continue;
            case "CommandSubstitution":
              continue; // command sub returns bytes
            default:
              return false;
          }
        }
        continue;
      case "ParameterExpansion":
        // Unquoted param expansion needs word splitting → can't use bytes path
        return false;
      default:
        // Glob, BraceExpansion, ArithmeticExpansion, CommandSubstitution, TildeExpansion
        return false;
    }
  }
  return word.parts.length > 0;
}

export interface InterpreterOptions {
  fs: IFileSystem;
  commands: CommandRegistry;
  limits: Required<ExecutionLimits>;
  exec: (
    script: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      stdin?: ByteStream;
    },
  ) => Promise<ExecResult>;
  /** Optional secure fetch function for network-enabled commands */
  fetch?: SecureFetch;
  /** Optional sleep function for testing with mock clocks */
  sleep?: (ms: number) => Promise<void>;
  /** Optional trace callback for performance profiling */
  trace?: TraceCallback;
  /** Optional feature coverage writer for fuzzing instrumentation */
  coverage?: FeatureCoverageWriter;
}

export class Interpreter {
  private ctx: InterpreterContext;

  constructor(options: InterpreterOptions, state: InterpreterState) {
    this.ctx = {
      state,
      fs: options.fs,
      commands: options.commands,
      limits: options.limits,
      execFn: options.exec,
      executeScript: this.executeScript.bind(this),
      executeStatement: this.executeStatement.bind(this),
      executeCommand: this.executeCommand.bind(this),
      fetch: options.fetch,
      sleep: options.sleep,
      trace: options.trace,
      coverage: options.coverage,
    };
  }

  /**
   * Build environment record containing only exported variables.
   */
  private buildExportedEnv(): Record<string, string> {
    const exportedVars = this.ctx.state.exportedVars;
    const tempExportedVars = this.ctx.state.tempExportedVars;

    const allExported = new Set<string>();
    if (exportedVars) {
      for (const name of exportedVars) {
        allExported.add(name);
      }
    }
    if (tempExportedVars) {
      for (const name of tempExportedVars) {
        allExported.add(name);
      }
    }

    if (allExported.size === 0) {
      return Object.create(null);
    }

    const env: Record<string, string> = Object.create(null);
    for (const name of allExported) {
      if (this.ctx.state.env.has(name)) {
        env[name] = envGet(this.ctx.state.env, name);
      }
    }
    return env;
  }

  async executeScript(node: ScriptNode): Promise<ExecResult> {
    let stdout: ByteStream = emptyStream();
    let stderr: ByteStream = emptyStream();
    let exitCode = 0;

    for (const statement of node.statements) {
      try {
        const result = await this.executeStatement(statement);
        stdout = concatStreams(stdout, result.stdout);
        stderr = concatStreams(stderr, result.stderr);
        exitCode = result.exitCode;
        this.ctx.state.lastExitCode = exitCode;
        envSet(this.ctx.state.env, "?", String(exitCode));
      } catch (error) {
        if (error instanceof ExitError) {
          error.prependOutput(stdout, stderr);
          throw error;
        }
        if (error instanceof PosixFatalError) {
          stdout = concatStreams(stdout, error.stdout);
          stderr = concatStreams(stderr, error.stderr);
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          return {
            stdout,
            stderr,
            exitCode,
            env: mapToRecord(this.ctx.state.env),
          };
        }
        if (error instanceof ExecutionLimitError) {
          throw error;
        }
        if (error instanceof ErrexitError) {
          stdout = concatStreams(stdout, error.stdout);
          stderr = concatStreams(stderr, error.stderr);
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          return {
            stdout,
            stderr,
            exitCode,
            env: mapToRecord(this.ctx.state.env),
          };
        }
        if (error instanceof NounsetError) {
          stdout = concatStreams(stdout, error.stdout);
          stderr = concatStreams(stderr, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          return {
            stdout,
            stderr,
            exitCode,
            env: mapToRecord(this.ctx.state.env),
          };
        }
        if (error instanceof BadSubstitutionError) {
          stdout = concatStreams(stdout, error.stdout);
          stderr = concatStreams(stderr, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          return {
            stdout,
            stderr,
            exitCode,
            env: mapToRecord(this.ctx.state.env),
          };
        }
        if (error instanceof ArithmeticError) {
          stdout = concatStreams(stdout, error.stdout);
          stderr = concatStreams(stderr, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          continue;
        }
        if (error instanceof BraceExpansionError) {
          stdout = concatStreams(stdout, error.stdout);
          stderr = concatStreams(stderr, error.stderr);
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          continue;
        }
        if (error instanceof BreakError || error instanceof ContinueError) {
          if (this.ctx.state.loopDepth > 0) {
            error.prependOutput(stdout, stderr);
            throw error;
          }
          stdout = concatStreams(stdout, error.stdout);
          stderr = concatStreams(stderr, error.stderr);
          continue;
        }
        if (error instanceof ReturnError) {
          error.prependOutput(stdout, stderr);
          throw error;
        }
        throw error;
      }
    }

    return {
      stdout,
      stderr,
      exitCode,
      env: mapToRecord(this.ctx.state.env),
    };
  }

  /**
   * Execute a user script file found in PATH.
   */
  private async executeUserScript(
    scriptPath: string,
    args: Uint8Array[],
    stdin: ByteStream = emptyStream(),
  ): Promise<ExecResult> {
    return executeUserScriptHelper(
      this.ctx,
      scriptPath,
      decodeArgs(args),
      stdin,
      (ast) => this.executeScript(ast),
    );
  }

  private async executeStatement(node: StatementNode): Promise<ExecResult> {
    this.ctx.state.commandCount++;
    if (this.ctx.state.commandCount > this.ctx.limits.maxCommandCount) {
      throwExecutionLimit(
        `too many commands executed (>${this.ctx.limits.maxCommandCount}), increase executionLimits.maxCommandCount`,
        "commands",
      );
    }

    if (node.deferredError) {
      throw new ParseException(node.deferredError.message, node.line ?? 1, 1);
    }

    if (this.ctx.state.options.noexec) {
      return ok();
    }

    this.ctx.state.errexitSafe = false;

    let stdout: ByteStream = emptyStream();
    let stderr: ByteStream = emptyStream();

    if (
      this.ctx.state.options.verbose &&
      !this.ctx.state.suppressVerbose &&
      node.sourceText
    ) {
      stderr = concatStreams(stderr, fromString(`${node.sourceText}\n`));
    }
    let exitCode = 0;
    let lastExecutedIndex = -1;
    let lastPipelineNegated = false;

    for (let i = 0; i < node.pipelines.length; i++) {
      const pipeline = node.pipelines[i];
      const operator = i > 0 ? node.operators[i - 1] : null;

      if (operator === "&&" && exitCode !== 0) continue;
      if (operator === "||" && exitCode === 0) continue;

      const result = await this.executePipeline(pipeline);
      stdout = concatStreams(stdout, result.stdout);
      stderr = concatStreams(stderr, result.stderr);
      exitCode = result.exitCode;
      lastExecutedIndex = i;
      lastPipelineNegated = pipeline.negated;

      this.ctx.state.lastExitCode = exitCode;
      envSet(this.ctx.state.env, "?", String(exitCode));
    }

    const wasShortCircuited = lastExecutedIndex < node.pipelines.length - 1;
    const innerWasSafe = this.ctx.state.errexitSafe;
    this.ctx.state.errexitSafe =
      wasShortCircuited || lastPipelineNegated || innerWasSafe;

    if (
      this.ctx.state.options.errexit &&
      exitCode !== 0 &&
      lastExecutedIndex === node.pipelines.length - 1 &&
      !lastPipelineNegated &&
      !this.ctx.state.inCondition &&
      !innerWasSafe
    ) {
      throw new ErrexitError(exitCode, stdout, stderr);
    }

    return { stdout, stderr, exitCode };
  }

  private async executePipeline(node: PipelineNode): Promise<ExecResult> {
    return executePipelineHelper(this.ctx, node, (cmd, stdin) =>
      this.executeCommand(cmd, stdin),
    );
  }

  private async executeCommand(
    node: CommandNode,
    stdin: ByteStream,
  ): Promise<ExecResult> {
    this.ctx.coverage?.hit(`bash:cmd:${node.type}`);
    switch (node.type) {
      case "SimpleCommand":
        return this.executeSimpleCommand(node, stdin);
      case "If":
        return executeIf(this.ctx, node);
      case "For":
        return executeFor(this.ctx, node);
      case "CStyleFor":
        return executeCStyleFor(this.ctx, node);
      case "While":
        return executeWhile(this.ctx, node, stdin);
      case "Until":
        return executeUntil(this.ctx, node);
      case "Case":
        return executeCase(this.ctx, node);
      case "Subshell":
        return this.executeSubshell(node, stdin);
      case "Group":
        return this.executeGroup(node, stdin);
      case "FunctionDef":
        return executeFunctionDef(this.ctx, node);
      case "ArithmeticCommand":
        return this.executeArithmeticCommand(node);
      case "ConditionalCommand":
        return this.executeConditionalCommand(node);
      default:
        return ok();
    }
  }

  private async executeSimpleCommand(
    node: SimpleCommandNode,
    stdin: ByteStream,
  ): Promise<ExecResult> {
    try {
      return await this.executeSimpleCommandInner(node, stdin);
    } catch (error) {
      if (error instanceof GlobError) {
        return { stdout: emptyStream(), stderr: error.stderr, exitCode: 1 };
      }
      throw error;
    }
  }

  private async executeSimpleCommandInner(
    node: SimpleCommandNode,
    stdin: ByteStream,
  ): Promise<ExecResult> {
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    if (this.ctx.state.shoptOptions.expand_aliases && node.name) {
      let currentNode = node;
      let maxExpansions = 100;
      while (maxExpansions > 0) {
        const expandedNode = this.expandAlias(currentNode);
        if (expandedNode === currentNode) {
          break;
        }
        currentNode = expandedNode;
        maxExpansions--;
      }
      this.aliasExpansionStack.clear();
      if (currentNode !== node) {
        node = currentNode;
      }
    }

    this.ctx.state.expansionStderr = "";

    const assignmentResult = await processAssignments(this.ctx, node);
    if (assignmentResult.error) {
      return assignmentResult.error;
    }
    const tempAssignments = assignmentResult.tempAssignments;
    const xtraceAssignmentOutput = assignmentResult.xtraceOutput;

    if (!node.name) {
      if (node.redirections.length > 0) {
        const redirectError = await preOpenOutputRedirects(
          this.ctx,
          node.redirections,
        );
        if (redirectError) {
          return redirectError;
        }
        const baseResult: ExecResult = {
          stdout: emptyStream(),
          stderr: fromString(xtraceAssignmentOutput),
          exitCode: 0,
        };
        return applyRedirections(this.ctx, baseResult, node.redirections);
      }

      this.ctx.state.lastArg = encode("");
      const stderrOutput =
        (this.ctx.state.expansionStderr || "") + xtraceAssignmentOutput;
      this.ctx.state.expansionStderr = "";
      return {
        stdout: emptyStream(),
        stderr: fromString(stderrOutput),
        exitCode: this.ctx.state.lastExitCode,
      };
    }

    const isLiteralAssignmentBuiltinForExport =
      node.name &&
      isWordLiteralMatch(node.name, [
        "local",
        "declare",
        "typeset",
        "export",
        "readonly",
      ]);
    const tempExportedVars = Array.from(tempAssignments.keys());
    if (tempExportedVars.length > 0 && !isLiteralAssignmentBuiltinForExport) {
      this.ctx.state.tempExportedVars =
        this.ctx.state.tempExportedVars || new Set();
      for (const name of tempExportedVars) {
        this.ctx.state.tempExportedVars.add(name);
      }
    }

    const fdVarError = await processFdVariableRedirections(
      this.ctx,
      node.redirections,
    );
    if (fdVarError) {
      for (const [name, value] of tempAssignments) {
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value);
      }
      return fdVarError;
    }

    let stdinSourceFd = -1;

    // Materialize stdin once for redirection mutations.
    let stdinBytes = await collectBytes(stdin);

    for (const redir of node.redirections) {
      if (
        (redir.operator === "<<" || redir.operator === "<<-") &&
        redir.target.type === "HereDoc"
      ) {
        const hereDoc = redir.target as HereDocNode;
        const fd = redir.fd ?? 0;
        if (fd === 0 && !hereDoc.stripTabs) {
          stdinBytes = await expandWordToBytes(this.ctx, hereDoc.content);
        } else {
          let content = await expandWord(this.ctx, hereDoc.content);
          if (hereDoc.stripTabs) {
            content = content
              .split("\n")
              .map((line) => line.replace(/^\t+/, ""))
              .join("\n");
          }
          if (fd !== 0) {
            if (!this.ctx.state.fileDescriptors) {
              this.ctx.state.fileDescriptors = new Map();
            }
            this.ctx.state.fileDescriptors.set(fd, content);
          } else {
            stdinBytes = encode(content);
          }
        }
        continue;
      }

      if (redir.operator === "<<<" && redir.target.type === "Word") {
        const hereStringBytes = await expandWordToBytes(
          this.ctx,
          redir.target as WordNode,
        );
        stdinBytes = concat(hereStringBytes, encode("\n"));
        continue;
      }

      if (redir.operator === "<" && redir.target.type === "Word") {
        try {
          const target = await expandWord(this.ctx, redir.target as WordNode);
          const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
          stdinBytes = await collectBytes(await this.ctx.fs.readFile(filePath));
        } catch {
          const target = await expandWord(this.ctx, redir.target as WordNode);
          for (const [name, value] of tempAssignments) {
            if (value === undefined) this.ctx.state.env.delete(name);
            else this.ctx.state.env.set(name, value);
          }
          return failure(`bash: ${target}: No such file or directory\n`);
        }
      }

      if (redir.operator === "<&" && redir.target.type === "Word") {
        const target = await expandWord(this.ctx, redir.target as WordNode);
        const sourceFd = Number.parseInt(target, 10);
        if (!Number.isNaN(sourceFd) && this.ctx.state.fileDescriptors) {
          const fdContent = this.ctx.state.fileDescriptors.get(sourceFd);
          if (fdContent !== undefined) {
            if (fdContent.startsWith("__rw__:")) {
              const parsed = parseRwFdContent(fdContent);
              if (parsed) {
                stdinBytes = encode(parsed.content.slice(parsed.position));
                stdinSourceFd = sourceFd;
              }
            } else if (
              fdContent.startsWith("__file__:") ||
              fdContent.startsWith("__file_append__:")
            ) {
              // Output-only.
            } else {
              stdinBytes = encode(fdContent);
            }
          }
        }
      }
    }

    const commandName = await expandWord(this.ctx, node.name);

    const args: Uint8Array[] = [];
    const quotedArgs: boolean[] = [];

    const isLiteralAssignmentBuiltin =
      isWordLiteralMatch(node.name, [
        "local",
        "declare",
        "typeset",
        "export",
        "readonly",
      ]) &&
      (commandName === "local" ||
        commandName === "declare" ||
        commandName === "typeset" ||
        commandName === "export" ||
        commandName === "readonly");

    if (isLiteralAssignmentBuiltin) {
      for (const arg of node.args) {
        const arrayAssignResult = await expandLocalArrayAssignmentHelper(
          this.ctx,
          arg,
        );
        if (arrayAssignResult) {
          args.push(encode(arrayAssignResult));
          quotedArgs.push(true);
        } else {
          const scalarAssignResult = await expandScalarAssignmentArgHelper(
            this.ctx,
            arg,
          );
          if (scalarAssignResult !== null) {
            args.push(encode(scalarAssignResult));
            quotedArgs.push(true);
          } else {
            const expanded = await expandWordWithGlob(this.ctx, arg);
            for (const value of expanded.values) {
              args.push(encode(value));
              quotedArgs.push(expanded.quoted);
            }
          }
        }
      }
    } else {
      for (const arg of node.args) {
        if (wordCanUseBytesPath(this.ctx, arg)) {
          args.push(await expandWordToBytes(this.ctx, arg));
          quotedArgs.push(true);
        } else {
          const expanded = await expandWordWithGlob(this.ctx, arg);
          for (const value of expanded.values) {
            args.push(encode(value));
            quotedArgs.push(expanded.quoted);
          }
        }
      }
    }

    if (!commandName) {
      const isOnlyExpansions = node.name.parts.every(
        (p) =>
          p.type === "CommandSubstitution" ||
          p.type === "ParameterExpansion" ||
          p.type === "ArithmeticExpansion",
      );
      if (isOnlyExpansions) {
        if (args.length > 0) {
          const newCommandName = decode(args.shift() as Uint8Array);
          quotedArgs.shift();
          return await this.runCommand(
            newCommandName,
            args,
            quotedArgs,
            fromBytes(stdinBytes),
            false,
            false,
            stdinSourceFd,
          );
        }
        return {
          stdout: emptyStream(),
          stderr: emptyStream(),
          exitCode: this.ctx.state.lastExitCode,
        };
      }
      return failure("bash: : command not found\n", 127);
    }

    if (
      commandName === "exec" &&
      (args.length === 0 || decode(args[0]) === "--")
    ) {
      for (const redir of node.redirections) {
        if (redir.target.type === "HereDoc") continue;
        if (redir.fdVariable) continue;

        const target = await expandWord(this.ctx, redir.target as WordNode);
        const fd =
          redir.fd ??
          (redir.operator === "<" || redir.operator === "<>" ? 0 : 1);

        if (!this.ctx.state.fileDescriptors) {
          this.ctx.state.fileDescriptors = new Map();
        }

        switch (redir.operator) {
          case ">":
          case ">|": {
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target,
            );
            await this.ctx.fs.writeFile(filePath, "", "utf8");
            this.ctx.state.fileDescriptors.set(fd, `__file__:${filePath}`);
            break;
          }
          case ">>": {
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target,
            );
            this.ctx.state.fileDescriptors.set(
              fd,
              `__file_append__:${filePath}`,
            );
            break;
          }
          case "<": {
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target,
            );
            try {
              const content = await this.ctx.fs.readFileText(filePath);
              this.ctx.state.fileDescriptors.set(fd, content);
            } catch {
              return failure(`bash: ${target}: No such file or directory\n`);
            }
            break;
          }
          case "<>": {
            const filePath = this.ctx.fs.resolvePath(
              this.ctx.state.cwd,
              target,
            );
            try {
              const content = await this.ctx.fs.readFileText(filePath);
              this.ctx.state.fileDescriptors.set(
                fd,
                `__rw__:${filePath.length}:${filePath}:0:${content}`,
              );
            } catch {
              await this.ctx.fs.writeFile(filePath, "", "utf8");
              this.ctx.state.fileDescriptors.set(
                fd,
                `__rw__:${filePath.length}:${filePath}:0:`,
              );
            }
            break;
          }
          case ">&": {
            if (target === "-") {
              this.ctx.state.fileDescriptors.delete(fd);
            } else if (target.endsWith("-")) {
              const sourceFdStr = target.slice(0, -1);
              const sourceFd = Number.parseInt(sourceFdStr, 10);
              if (!Number.isNaN(sourceFd)) {
                const sourceInfo = this.ctx.state.fileDescriptors.get(sourceFd);
                if (sourceInfo !== undefined) {
                  this.ctx.state.fileDescriptors.set(fd, sourceInfo);
                } else {
                  this.ctx.state.fileDescriptors.set(
                    fd,
                    `__dupout__:${sourceFd}`,
                  );
                }
                this.ctx.state.fileDescriptors.delete(sourceFd);
              }
            } else {
              const sourceFd = Number.parseInt(target, 10);
              if (!Number.isNaN(sourceFd)) {
                this.ctx.state.fileDescriptors.set(
                  fd,
                  `__dupout__:${sourceFd}`,
                );
              }
            }
            break;
          }
          case "<&": {
            if (target === "-") {
              this.ctx.state.fileDescriptors.delete(fd);
            } else if (target.endsWith("-")) {
              const sourceFdStr = target.slice(0, -1);
              const sourceFd = Number.parseInt(sourceFdStr, 10);
              if (!Number.isNaN(sourceFd)) {
                const sourceInfo = this.ctx.state.fileDescriptors.get(sourceFd);
                if (sourceInfo !== undefined) {
                  this.ctx.state.fileDescriptors.set(fd, sourceInfo);
                } else {
                  this.ctx.state.fileDescriptors.set(
                    fd,
                    `__dupin__:${sourceFd}`,
                  );
                }
                this.ctx.state.fileDescriptors.delete(sourceFd);
              }
            } else {
              const sourceFd = Number.parseInt(target, 10);
              if (!Number.isNaN(sourceFd)) {
                this.ctx.state.fileDescriptors.set(fd, `__dupin__:${sourceFd}`);
              }
            }
            break;
          }
        }
      }
      for (const [name, value] of tempAssignments) {
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value);
      }
      if (this.ctx.state.tempExportedVars) {
        for (const name of tempAssignments.keys()) {
          this.ctx.state.tempExportedVars.delete(name);
        }
      }
      return ok();
    }

    const xtraceOutput = await traceSimpleCommand(
      this.ctx,
      commandName,
      args.map((a) => decode(a)),
    );

    if (tempAssignments.size > 0) {
      this.ctx.state.tempEnvBindings = this.ctx.state.tempEnvBindings || [];
      this.ctx.state.tempEnvBindings.push(new Map(tempAssignments));
    }

    let cmdResult: ExecResult;
    let controlFlowError: BreakError | ContinueError | null = null;

    try {
      cmdResult = await this.runCommand(
        commandName,
        args,
        quotedArgs,
        fromBytes(stdinBytes),
        false,
        false,
        stdinSourceFd,
      );
    } catch (error) {
      if (error instanceof BreakError || error instanceof ContinueError) {
        controlFlowError = error;
        cmdResult = ok();
      } else {
        throw error;
      }
    }

    const stderrPrefix = xtraceAssignmentOutput + xtraceOutput;
    if (stderrPrefix) {
      cmdResult = {
        ...cmdResult,
        stderr: concatStreams(fromString(stderrPrefix), cmdResult.stderr),
      };
    }

    cmdResult = await applyRedirections(this.ctx, cmdResult, node.redirections);

    if (controlFlowError) {
      throw controlFlowError;
    }

    if (args.length > 0) {
      let lastArgStr = decode(args[args.length - 1]);
      if (
        (commandName === "declare" ||
          commandName === "local" ||
          commandName === "typeset") &&
        /^[a-zA-Z_][a-zA-Z0-9_]*=\(/.test(lastArgStr)
      ) {
        const match = lastArgStr.match(/^([a-zA-Z_][a-zA-Z0-9_]*)=\(/);
        if (match) {
          lastArgStr = match[1];
        }
      }
      this.ctx.state.lastArg = encode(lastArgStr);
    } else {
      this.ctx.state.lastArg = encode(commandName);
    }

    const isPosixSpecialWithPersistence =
      isPosixSpecialBuiltin(commandName) &&
      commandName !== "unset" &&
      commandName !== "eval";
    const shouldRestoreTempAssignments =
      !this.ctx.state.options.posix || !isPosixSpecialWithPersistence;

    if (shouldRestoreTempAssignments) {
      for (const [name, value] of tempAssignments) {
        if (this.ctx.state.fullyUnsetLocals?.has(name)) {
          continue;
        }
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value);
      }
    }

    if (this.ctx.state.tempExportedVars) {
      for (const name of tempAssignments.keys()) {
        this.ctx.state.tempExportedVars.delete(name);
      }
    }

    if (tempAssignments.size > 0 && this.ctx.state.tempEnvBindings) {
      this.ctx.state.tempEnvBindings.pop();
    }

    if (this.ctx.state.expansionStderr) {
      cmdResult = {
        ...cmdResult,
        stderr: concatStreams(
          fromString(this.ctx.state.expansionStderr),
          cmdResult.stderr,
        ),
      };
      this.ctx.state.expansionStderr = "";
    }

    return cmdResult;
  }

  private async runCommand(
    commandName: string,
    args: Uint8Array[],
    quotedArgs: boolean[],
    stdin: ByteStream,
    skipFunctions = false,
    useDefaultPath = false,
    stdinSourceFd = -1,
  ): Promise<ExecResult> {
    const dispatchCtx: BuiltinDispatchContext = {
      ctx: this.ctx,
      runCommand: (name, a, qa, s, sf, udp, ssf) =>
        this.runCommand(name, a, qa, s, sf, udp, ssf),
      buildExportedEnv: () => this.buildExportedEnv(),
      executeUserScript: (path, a, s) =>
        this.executeUserScript(path, a, s ?? emptyStream()),
    };

    const builtinResult = await dispatchBuiltin(
      dispatchCtx,
      commandName,
      args,
      quotedArgs,
      stdin,
      skipFunctions,
      useDefaultPath,
      stdinSourceFd,
    );

    if (builtinResult !== null) {
      return builtinResult;
    }

    return executeExternalCommand(
      dispatchCtx,
      commandName,
      args,
      stdin,
      useDefaultPath,
    );
  }

  private aliasExpansionStack: Set<string> = new Set();

  private expandAlias(node: SimpleCommandNode): SimpleCommandNode {
    return expandAliasHelper(this.ctx.state, node, this.aliasExpansionStack);
  }

  async findCommandInPath(commandName: string): Promise<string[]> {
    return findCommandInPathHelper(this.ctx, commandName);
  }

  private async executeSubshell(
    node: SubshellNode,
    stdin: ByteStream = emptyStream(),
  ): Promise<ExecResult> {
    return executeSubshellHelper(this.ctx, node, stdin, (stmt) =>
      this.executeStatement(stmt),
    );
  }

  private async executeGroup(
    node: GroupNode,
    stdin: ByteStream = emptyStream(),
  ): Promise<ExecResult> {
    return executeGroupHelper(this.ctx, node, stdin, (stmt) =>
      this.executeStatement(stmt),
    );
  }

  private async executeArithmeticCommand(
    node: ArithmeticCommandNode,
  ): Promise<ExecResult> {
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    const preOpenError = await preOpenOutputRedirects(
      this.ctx,
      node.redirections,
    );
    if (preOpenError) {
      return preOpenError;
    }

    try {
      const arithResult = await evaluateArithmetic(
        this.ctx,
        node.expression.expression,
      );
      let bodyResult = testResult(arithResult !== 0);
      if (this.ctx.state.expansionStderr) {
        bodyResult = {
          ...bodyResult,
          stderr: concatStreams(
            fromString(this.ctx.state.expansionStderr),
            bodyResult.stderr,
          ),
        };
        this.ctx.state.expansionStderr = "";
      }
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    } catch (error) {
      const bodyResult = failure(
        `bash: arithmetic expression: ${(error as Error).message}\n`,
      );
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    }
  }

  private async executeConditionalCommand(
    node: ConditionalCommandNode,
  ): Promise<ExecResult> {
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    const preOpenError = await preOpenOutputRedirects(
      this.ctx,
      node.redirections,
    );
    if (preOpenError) {
      return preOpenError;
    }

    try {
      const condResult = await evaluateConditional(this.ctx, node.expression);
      let bodyResult = testResult(condResult);
      if (this.ctx.state.expansionStderr) {
        bodyResult = {
          ...bodyResult,
          stderr: concatStreams(
            fromString(this.ctx.state.expansionStderr),
            bodyResult.stderr,
          ),
        };
        this.ctx.state.expansionStderr = "";
      }
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    } catch (error) {
      const exitCode = error instanceof ArithmeticError ? 1 : 2;
      const bodyResult = failure(
        `bash: conditional expression: ${(error as Error).message}\n`,
        exitCode,
      );
      return applyRedirections(this.ctx, bodyResult, node.redirections);
    }
  }
}
