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
import type { ProcessTable } from "../process/process-table.js";
import type {
  CommandRegistry,
  ExecResult,
  FeatureCoverageWriter,
  TraceCallback,
} from "../types.js";
import { combineAbortSignals } from "../utils/abort.js";
import {
  concat,
  decode,
  decodeArgs,
  EMPTY,
  encode,
  envGet,
  envSet,
} from "../utils/bytes.js";
import {
  type ByteStream,
  collectBytes,
  emptyStream,
  fromBytes,
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
  AbortExecutionError,
  ArithmeticError,
  BadSubstitutionError,
  BraceExpansionError,
  BreakError,
  ContinueError,
  checkAborted,
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
  successText,
  testResult,
  throwExecutionLimit,
} from "./helpers/result.js";
import {
  isPosixSpecialBuiltin,
  SHELL_BUILTINS,
} from "./helpers/shell-constants.js";
import {
  isWordLiteralMatch,
  parseRwFdContent,
} from "./helpers/word-matching.js";
import { traceSimpleCommand } from "./helpers/xtrace.js";
import {
  cloneOutputChannels,
  createCollector,
  executeAndPumpResult,
  isChannelClosed,
  type OutputChannels,
  pumpResult,
  withChannels,
  writeErrorDiagnostic,
  writeErrorDiagnosticWithWriteFailure,
  writeToChannel,
} from "./output-channels.js";
import { executePipeline as executePipelineHelper } from "./pipeline-execution.js";
import {
  applyPersistentOutputRedirections,
  compileOutputRedirections,
} from "./redirect-channels.js";
import { getBadFileDescriptorError } from "./redirections.js";
import { processAssignments } from "./simple-command-assignments.js";
import {
  executeGroup as executeGroupHelper,
  executeSubshell as executeSubshellHelper,
  executeUserScript as executeUserScriptHelper,
} from "./subshell-group.js";
import type {
  InterpreterContext,
  InterpreterState,
  JobExecutionTracker,
} from "./types.js";

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
  processes: ProcessTable;
  lineageId: number;
  outputChannels: OutputChannels;
  limits: Required<ExecutionLimits>;
  jobTracker: JobExecutionTracker;
  exec: (
    script: string,
    options?: {
      env?: Record<string, string>;
      cwd?: string;
      stdin?: ByteStream;
      signal?: AbortSignal;
    },
  ) => Promise<ExecResult>;
  /** Optional secure fetch function for network-enabled commands */
  fetch?: SecureFetch;
  /** Optional sleep function for testing with mock clocks */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional trace callback for performance profiling */
  trace?: TraceCallback;
  /** Optional feature coverage writer for fuzzing instrumentation */
  coverage?: FeatureCoverageWriter;
  /** Abort signal for this execution (from ExecOptions.signal) */
  signal?: AbortSignal;
}

export class Interpreter {
  private ctx: InterpreterContext;

  constructor(options: InterpreterOptions, state: InterpreterState) {
    this.ctx = {
      state,
      fs: options.fs,
      commands: options.commands,
      processes: options.processes,
      lineageId: options.lineageId,
      outputChannels: options.outputChannels,
      reportedDiagnostics: new WeakSet(),
      limits: options.limits,
      jobTracker: options.jobTracker,
      execFn: options.exec,
      executeScript: this.executeScript.bind(this),
      executeStatement: this.executeStatement.bind(this),
      executeCommand: this.executeCommand.bind(this),
      fetch: options.fetch,
      sleep: options.sleep,
      trace: options.trace,
      coverage: options.coverage,
      signal: options.signal,
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

  async executeRootScript(node: ScriptNode): Promise<ExecResult> {
    const result = await this.executeScript(node);
    checkAborted(this.ctx.signal);
    return pumpResult(this.ctx, result);
  }

  async executeScript(node: ScriptNode): Promise<ExecResult> {
    let exitCode = 0;

    for (const statement of node.statements) {
      try {
        const result = await this.executeStatement(statement);
        const childHandledAbort =
          this.ctx.signal?.aborted === true &&
          result.exitCode ===
            new AbortExecutionError(this.ctx.signal.reason).exitCode;
        await pumpResult(this.ctx, result, !childHandledAbort);
        exitCode = result.exitCode;
        this.ctx.state.lastExitCode = exitCode;
        envSet(this.ctx.state.env, "?", String(exitCode));
      } catch (error) {
        await writeErrorDiagnostic(this.ctx, error);
        if (error instanceof ExitError) {
          throw error;
        }
        if (error instanceof PosixFatalError) {
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          return {
            stdout: emptyStream(),
            stderr: emptyStream(),
            exitCode,
            env: mapToRecord(this.ctx.state.env),
          };
        }
        if (error instanceof ExecutionLimitError) {
          throw error;
        }
        if (error instanceof ErrexitError) {
          exitCode = error.exitCode;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          return {
            stdout: emptyStream(),
            stderr: emptyStream(),
            exitCode,
            env: mapToRecord(this.ctx.state.env),
          };
        }
        if (error instanceof NounsetError) {
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          return {
            stdout: emptyStream(),
            stderr: emptyStream(),
            exitCode,
            env: mapToRecord(this.ctx.state.env),
          };
        }
        if (error instanceof BadSubstitutionError) {
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          return {
            stdout: emptyStream(),
            stderr: emptyStream(),
            exitCode,
            env: mapToRecord(this.ctx.state.env),
          };
        }
        if (error instanceof ArithmeticError) {
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          continue;
        }
        if (error instanceof BraceExpansionError) {
          exitCode = 1;
          this.ctx.state.lastExitCode = exitCode;
          envSet(this.ctx.state.env, "?", String(exitCode));
          continue;
        }
        if (error instanceof BreakError || error instanceof ContinueError) {
          if (this.ctx.state.loopDepth > 0) {
            throw error;
          }
          continue;
        }
        if (error instanceof ReturnError) {
          throw error;
        }
        throw error;
      }
    }

    return {
      stdout: emptyStream(),
      stderr: emptyStream(),
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
    checkAborted(this.ctx.signal);

    this.ctx.state.commandCount++;
    if (this.ctx.state.commandCount > this.ctx.limits.maxCommandCount) {
      throwExecutionLimit(
        `too many commands executed (>${this.ctx.limits.maxCommandCount}), increase executionLimits.maxCommandCount`,
        "commands",
      );
    }

    // Statement-dense scripts award only microtasks between statements, so a
    // timer-fired abort (e.g. AbortSignal.timeout) could starve forever.
    // When cancellation is possible, periodically yield to the macrotask
    // queue so pending timers get a chance to fire.
    if (this.ctx.signal && this.ctx.state.commandCount % 1024 === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      checkAborted(this.ctx.signal);
    }

    if (node.deferredError) {
      throw new ParseException(node.deferredError.message, node.line ?? 1, 1);
    }

    if (this.ctx.state.options.noexec) {
      return ok();
    }

    this.ctx.state.errexitSafe = false;

    if (
      this.ctx.state.options.verbose &&
      !this.ctx.state.suppressVerbose &&
      node.sourceText
    ) {
      await writeToChannel(this.ctx, 2, `${node.sourceText}\n`);
    }

    if (node.background) {
      if (
        this.ctx.processes.runningCount >= this.ctx.limits.maxConcurrentJobs
      ) {
        this.ctx.jobTracker.limitExceeded = true;
        await writeToChannel(
          this.ctx,
          2,
          `bash: maximum concurrent jobs (${this.ctx.limits.maxConcurrentJobs}) exceeded\n`,
        );
        return failure("", ExecutionLimitError.EXIT_CODE);
      }

      const parentState = this.ctx.state;
      const jobState: InterpreterState = {
        ...parentState,
        env: new Map(
          [...parentState.env].map(([name, value]) => [name, value.slice()]),
        ),
        functions: new Map(parentState.functions),
        localScopes: parentState.localScopes.map(
          (scope) =>
            new Map([...scope].map(([name, value]) => [name, value?.slice()])),
        ),
        options: { ...parentState.options },
        shoptOptions: { ...parentState.shoptOptions },
        lastArg: parentState.lastArg.slice(),
        groupStdin: undefined,
        ...(parentState.fileDescriptors
          ? { fileDescriptors: new Map(parentState.fileDescriptors) }
          : {}),
        ...(parentState.readonlyVars
          ? { readonlyVars: new Set(parentState.readonlyVars) }
          : {}),
        ...(parentState.associativeArrays
          ? { associativeArrays: new Set(parentState.associativeArrays) }
          : {}),
        ...(parentState.namerefs
          ? { namerefs: new Set(parentState.namerefs) }
          : {}),
        ...(parentState.boundNamerefs
          ? { boundNamerefs: new Set(parentState.boundNamerefs) }
          : {}),
        ...(parentState.invalidNamerefs
          ? { invalidNamerefs: new Set(parentState.invalidNamerefs) }
          : {}),
        ...(parentState.integerVars
          ? { integerVars: new Set(parentState.integerVars) }
          : {}),
        ...(parentState.lowercaseVars
          ? { lowercaseVars: new Set(parentState.lowercaseVars) }
          : {}),
        ...(parentState.uppercaseVars
          ? { uppercaseVars: new Set(parentState.uppercaseVars) }
          : {}),
        ...(parentState.exportedVars
          ? { exportedVars: new Set(parentState.exportedVars) }
          : {}),
        ...(parentState.tempExportedVars
          ? { tempExportedVars: new Set(parentState.tempExportedVars) }
          : {}),
        ...(parentState.localExportedVars
          ? {
              localExportedVars: parentState.localExportedVars.map(
                (names) => new Set(names),
              ),
            }
          : {}),
        ...(parentState.declaredVars
          ? { declaredVars: new Set(parentState.declaredVars) }
          : {}),
        ...(parentState.localVarDepth
          ? { localVarDepth: new Map(parentState.localVarDepth) }
          : {}),
        ...(parentState.localVarStack
          ? {
              localVarStack: new Map(
                [...parentState.localVarStack].map(([name, entries]) => [
                  name,
                  entries.map((entry) => ({
                    ...entry,
                    value: entry.value?.slice(),
                  })),
                ]),
              ),
            }
          : {}),
        ...(parentState.fullyUnsetLocals
          ? { fullyUnsetLocals: new Map(parentState.fullyUnsetLocals) }
          : {}),
        ...(parentState.tempEnvBindings
          ? {
              tempEnvBindings: parentState.tempEnvBindings.map(
                (bindings) =>
                  new Map(
                    [...bindings].map(([name, value]) => [
                      name,
                      value?.slice(),
                    ]),
                  ),
              ),
            }
          : {}),
        ...(parentState.mutatedTempEnvVars
          ? {
              mutatedTempEnvVars: new Set(parentState.mutatedTempEnvVars),
            }
          : {}),
        ...(parentState.accessedTempEnvVars
          ? {
              accessedTempEnvVars: new Set(parentState.accessedTempEnvVars),
            }
          : {}),
        ...(parentState.callLineStack
          ? { callLineStack: [...parentState.callLineStack] }
          : {}),
        ...(parentState.funcNameStack
          ? { funcNameStack: [...parentState.funcNameStack] }
          : {}),
        ...(parentState.sourceStack
          ? { sourceStack: [...parentState.sourceStack] }
          : {}),
        ...(parentState.completionSpecs
          ? { completionSpecs: new Map(parentState.completionSpecs) }
          : {}),
        ...(parentState.directoryStack
          ? { directoryStack: [...parentState.directoryStack] }
          : {}),
        ...(parentState.hashTable
          ? { hashTable: new Map(parentState.hashTable) }
          : {}),
      };
      const processes = this.ctx.processes;
      const inheritedChannels = this.ctx.outputChannels;
      const createJobChannels = (jobPid: number): OutputChannels =>
        cloneOutputChannels(inheritedChannels, (fd, inheritedSink) => {
          if (!processes.observesOutput) {
            return inheritedSink;
          }
          return createCollector(
            {
              write(chunk) {
                processes.observeOutput(jobPid, fd, chunk);
                return inheritedSink.write(chunk);
              },
            },
            false,
          );
        });
      const command = node.sourceText?.trim() || "<background job>";
      let pid: number;

      try {
        pid = processes.start(
          command,
          async (jobPid, jobSignal) => {
            const jobChannels = createJobChannels(jobPid);
            jobState.bashPid = jobPid;
            jobState.nextVirtualPid = Math.max(
              jobState.nextVirtualPid,
              jobPid + 1,
            );
            const signal = combineAbortSignals(this.ctx.signal, jobSignal);
            const child = new Interpreter(
              {
                fs: this.ctx.fs,
                commands: this.ctx.commands,
                processes,
                lineageId: this.ctx.lineageId,
                outputChannels: jobChannels,
                limits: this.ctx.limits,
                jobTracker: this.ctx.jobTracker,
                exec: (script, options) =>
                  this.ctx.execFn(script, {
                    ...options,
                    signal: combineAbortSignals(signal, options?.signal),
                  }),
                fetch: this.ctx.fetch,
                sleep: this.ctx.sleep,
                trace: this.ctx.trace,
                coverage: this.ctx.coverage,
                signal,
              },
              jobState,
            );

            try {
              const result = await child.executeRootScript({
                type: "Script",
                statements: [
                  { ...node, background: false, sourceText: undefined },
                ],
              });
              return result.exitCode;
            } catch (error) {
              if (error instanceof AbortExecutionError) {
                return error.exitCode;
              }
              if (error instanceof ExitError) {
                return error.exitCode;
              }
              if (error instanceof ExecutionLimitError) {
                this.ctx.jobTracker.limitExceeded = true;
                return ExecutionLimitError.EXIT_CODE;
              }
              throw error;
            }
          },
          this.ctx.lineageId,
        );
        this.ctx.jobTracker.started = true;
      } catch (error) {
        await writeToChannel(
          this.ctx,
          2,
          `bash: ${error instanceof Error ? error.message : String(error)}\n`,
        );
        return failure("", 1);
      }

      this.ctx.state.lastBackgroundPid = pid;
      return ok();
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
      throw new ErrexitError(exitCode);
    }

    return { stdout: emptyStream(), stderr: emptyStream(), exitCode };
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
    this.ctx.reportedDiagnostics = new WeakSet();
    try {
      return await this.executeSimpleCommandInner(node, stdin);
    } catch (error) {
      if (error instanceof GlobError) {
        await writeErrorDiagnostic(this.ctx, error);
        return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 1 };
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

    const assignmentResult = await processAssignments(this.ctx, node);
    if (assignmentResult.error) {
      return assignmentResult.error;
    }
    const tempAssignments = assignmentResult.tempAssignments;
    const xtraceAssignmentOutput = assignmentResult.xtraceOutput;

    if (!node.name) {
      await writeToChannel(this.ctx, 2, xtraceAssignmentOutput);
      if (node.redirections.length > 0) {
        const currentChannels = this.ctx.outputChannels;
        const compiled = await compileOutputRedirections(
          this.ctx,
          currentChannels,
          node.redirections,
        );
        if (compiled.error) {
          return await withChannels(this.ctx, compiled.channels, () =>
            executeAndPumpResult(this.ctx, () =>
              Promise.resolve(compiled.error as ExecResult),
            ),
          );
        }
        const baseResult: ExecResult = {
          stdout: emptyStream(),
          stderr: emptyStream(),
          exitCode: 0,
        };
        const outputFds = ([1, 2] as const).filter((fd) => {
          const before = currentChannels.bindings.get(fd);
          const after = compiled.channels.bindings.get(fd);
          return (
            before?.sink !== after?.sink ||
            isChannelClosed(currentChannels, fd) !==
              isChannelClosed(compiled.channels, fd)
          );
        });
        return await withChannels(this.ctx, compiled.channels, () =>
          executeAndPumpResult(
            this.ctx,
            () => Promise.resolve(baseResult),
            outputFds,
          ),
        );
      }

      this.ctx.state.lastArg = encode("");
      return {
        stdout: emptyStream(),
        stderr: emptyStream(),
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

    let stdinSourceFd = -1;
    const isRedirectOnlyExec =
      isWordLiteralMatch(node.name, ["exec"]) &&
      (node.args.length === 0 ||
        (node.args.length === 1 && isWordLiteralMatch(node.args[0], ["--"])));
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

    const currentChannels = this.ctx.outputChannels;
    const channelRedirections =
      !isRedirectOnlyExec && node.redirections.length > 0
        ? await compileOutputRedirections(
            this.ctx,
            currentChannels,
            node.redirections,
            {
              persistMovedSource: SHELL_BUILTINS.has(commandName),
            },
          )
        : undefined;
    if (channelRedirections?.error) {
      await writeToChannel(this.ctx, 2, xtraceAssignmentOutput);
      for (const [name, value] of tempAssignments) {
        if (value === undefined) this.ctx.state.env.delete(name);
        else this.ctx.state.env.set(name, value);
      }
      return await withChannels(this.ctx, channelRedirections.channels, () =>
        executeAndPumpResult(this.ctx, () =>
          Promise.resolve(channelRedirections.error as ExecResult),
        ),
      );
    }

    // Fast path: when no redirection mutates stdin, pass the pipeline
    // stream through untouched. This is critical for performance —
    // `cat huge | head -c 5` MUST NOT drain `cat`'s stream here.
    const stdinAffectingRedir = node.redirections.some((r) => {
      if (isRedirectOnlyExec && (r.operator === "<" || r.operator === "<&")) {
        return false;
      }
      if (r.fdVariable) return false;
      if (r.operator === "<<" || r.operator === "<<-" || r.operator === "<<<")
        return true;
      const fd = r.fd ?? 0;
      return (r.operator === "<" || r.operator === "<&") && fd === 0;
    });

    let stdinStream: ByteStream | null = null;
    let stdinBytes: Uint8Array = EMPTY;
    if (stdinAffectingRedir) {
      // We're going to mutate stdin via redirections — materialize once.
      stdinBytes = await collectBytes(stdin);
    } else {
      // No mutation; thread the lazy stream straight through.
      stdinStream = stdin;
    }

    const inputRedirections =
      channelRedirections?.legacyRedirections ?? node.redirections;
    for (const redir of inputRedirections) {
      // The channel compiler above installs FD-variable descriptors in lexical
      // order. They do not replace fd 0, and their targets expand there once.
      if (
        redir.fdVariable ||
        (isRedirectOnlyExec &&
          (redir.operator === "<" || redir.operator === "<&"))
      ) {
        continue;
      }

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

      if (
        redir.operator === "<&" &&
        (redir.fd ?? 0) === 0 &&
        redir.target.type === "Word"
      ) {
        const target = await expandWord(this.ctx, redir.target as WordNode);
        const normalizedSource = target.startsWith("&")
          ? target.slice(1)
          : target;
        if (normalizedSource !== "-" && !/^\d+-?$/.test(normalizedSource)) {
          for (const [name, value] of tempAssignments) {
            if (value === undefined) this.ctx.state.env.delete(name);
            else this.ctx.state.env.set(name, value);
          }
          return failure(`bash: ${target}: ambiguous redirect\n`);
        }
        const sourceFd = Number.parseInt(normalizedSource, 10);
        if (
          !Number.isNaN(sourceFd) &&
          isChannelClosed(this.ctx.outputChannels, sourceFd)
        ) {
          for (const [name, value] of tempAssignments) {
            if (value === undefined) this.ctx.state.env.delete(name);
            else this.ctx.state.env.set(name, value);
          }
          return failure(getBadFileDescriptorError(sourceFd));
        }
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
          } else if (
            sourceFd >= 3 &&
            !this.ctx.outputChannels.bindings.get(sourceFd)?.sink
          ) {
            for (const [name, value] of tempAssignments) {
              if (value === undefined) this.ctx.state.env.delete(name);
              else this.ctx.state.env.set(name, value);
            }
            return failure(getBadFileDescriptorError(sourceFd));
          }
        } else if (
          !Number.isNaN(sourceFd) &&
          sourceFd >= 3 &&
          !this.ctx.outputChannels.bindings.get(sourceFd)?.sink
        ) {
          for (const [name, value] of tempAssignments) {
            if (value === undefined) this.ctx.state.env.delete(name);
            else this.ctx.state.env.set(name, value);
          }
          return failure(getBadFileDescriptorError(sourceFd));
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
            stdinStream ?? fromBytes(stdinBytes),
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

    await writeToChannel(this.ctx, 2, xtraceAssignmentOutput);
    const xtraceOutput = await traceSimpleCommand(
      this.ctx,
      commandName,
      args.map((a) => decode(a)),
    );
    await writeToChannel(this.ctx, 2, xtraceOutput);

    if (
      commandName === "exec" &&
      (args.length === 0 || decode(args[0]) === "--")
    ) {
      const channelSnapshots: Array<
        [OutputChannels, OutputChannels["bindings"]]
      > = [];
      let channelToSnapshot: OutputChannels | undefined =
        this.ctx.outputChannels;
      while (channelToSnapshot) {
        channelSnapshots.push([
          channelToSnapshot,
          new Map(channelToSnapshot.bindings),
        ]);
        channelToSnapshot = channelToSnapshot.parent;
      }
      const savedFileDescriptors = this.ctx.state.fileDescriptors
        ? new Map(this.ctx.state.fileDescriptors)
        : undefined;
      const savedNextFd = this.ctx.state.nextFd;
      const savedFdVariables = new Map<string, Uint8Array | undefined>();
      for (const redir of node.redirections) {
        if (redir.fdVariable && !savedFdVariables.has(redir.fdVariable)) {
          savedFdVariables.set(
            redir.fdVariable,
            this.ctx.state.env.get(redir.fdVariable),
          );
        }
      }

      const persistent = await applyPersistentOutputRedirections(
        this.ctx,
        node.redirections,
      );
      if (persistent.error) {
        let errorResult: ExecResult;
        try {
          errorResult = await withChannels(this.ctx, persistent.channels, () =>
            executeAndPumpResult(this.ctx, () =>
              Promise.resolve(persistent.error as ExecResult),
            ),
          );
        } finally {
          for (const [channels, bindings] of channelSnapshots) {
            channels.bindings = new Map(bindings);
          }
          this.ctx.state.fileDescriptors = savedFileDescriptors;
          this.ctx.state.nextFd = savedNextFd;
          for (const [name, value] of savedFdVariables) {
            if (value === undefined) this.ctx.state.env.delete(name);
            else this.ctx.state.env.set(name, value);
          }
        }
        return errorResult;
      }

      for (const redir of persistent.legacyRedirections) {
        if (redir.target.type === "HereDoc" || redir.fdVariable) continue;

        const target = await expandWord(this.ctx, redir.target as WordNode);
        const fd =
          redir.fd ??
          (redir.operator === "<" || redir.operator === "<>" ? 0 : 1);

        if (!this.ctx.state.fileDescriptors) {
          this.ctx.state.fileDescriptors = new Map();
        }

        if (redir.operator === "<") {
          const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
          try {
            const content = await this.ctx.fs.readFileText(filePath);
            this.ctx.state.fileDescriptors.set(fd, content);
          } catch {
            let errorResult: ExecResult;
            try {
              errorResult = await executeAndPumpResult(this.ctx, () =>
                Promise.resolve(
                  failure(`bash: ${target}: No such file or directory\n`),
                ),
              );
            } finally {
              for (const [channels, bindings] of channelSnapshots) {
                channels.bindings = new Map(bindings);
              }
              this.ctx.state.fileDescriptors = savedFileDescriptors;
              this.ctx.state.nextFd = savedNextFd;
              for (const [name, value] of savedFdVariables) {
                if (value === undefined) this.ctx.state.env.delete(name);
                else this.ctx.state.env.set(name, value);
              }
            }
            return errorResult;
          }
        } else if (redir.operator === "<>") {
          const filePath = this.ctx.fs.resolvePath(this.ctx.state.cwd, target);
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
        } else if (redir.operator === "<&") {
          if (target === "-") {
            this.ctx.state.fileDescriptors.delete(fd);
          } else {
            const moveSource = target.endsWith("-");
            const sourceFd = Number.parseInt(
              moveSource ? target.slice(0, -1) : target,
              10,
            );
            if (!Number.isNaN(sourceFd)) {
              const sourceInfo =
                this.ctx.state.fileDescriptors.get(sourceFd) ??
                `__dupin__:${sourceFd}`;
              this.ctx.state.fileDescriptors.set(fd, sourceInfo);
              if (moveSource) {
                this.ctx.state.fileDescriptors.delete(sourceFd);
              }
            }
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

    if (tempAssignments.size > 0) {
      this.ctx.state.tempEnvBindings = this.ctx.state.tempEnvBindings || [];
      this.ctx.state.tempEnvBindings.push(new Map(tempAssignments));
    }

    let cmdResult!: ExecResult;
    let controlFlowError: BreakError | ContinueError | null = null;
    const outputFds = channelRedirections
      ? ([1, 2] as const).filter((fd) => {
          const before = currentChannels.bindings.get(fd);
          const after = channelRedirections.channels.bindings.get(fd);
          return (
            before?.sink !== after?.sink ||
            isChannelClosed(currentChannels, fd) !==
              isChannelClosed(channelRedirections.channels, fd)
          );
        })
      : [];

    try {
      try {
        const run = () =>
          this.runCommand(
            commandName,
            args,
            quotedArgs,
            stdinStream ?? fromBytes(stdinBytes),
            false,
            false,
            stdinSourceFd,
          );
        cmdResult = channelRedirections
          ? await withChannels(this.ctx, channelRedirections.channels, run)
          : await run();
      } catch (error) {
        let writeFailure: ExecResult | null = null;
        if (channelRedirections) {
          const pumpedError = await withChannels(
            this.ctx,
            channelRedirections.channels,
            () =>
              writeErrorDiagnosticWithWriteFailure(this.ctx, error, outputFds),
          );
          writeFailure = pumpedError.writeFailure;
          if (writeFailure) {
            cmdResult = writeFailure;
          }
        }
        if (writeFailure) {
          // A sink failure replaces the command's original control-flow error.
        } else if (
          error instanceof BreakError ||
          error instanceof ContinueError
        ) {
          controlFlowError = error;
          cmdResult = ok();
        } else {
          throw error;
        }
      }

      // Some shell builtins are intentionally only advertised, not
      // implemented. Preserve the legacy /dev/full behavior for those
      // output-producing builtins: the write failure wins over the internal
      // command-resolution fallback.
      if (
        cmdResult.exitCode === 127 &&
        SHELL_BUILTINS.has(commandName) &&
        channelRedirections?.channels.bindings.get(1)?.descriptor ===
          "__file__:/dev/full"
      ) {
        cmdResult = successText("\n");
      }

      if (channelRedirections && outputFds.length > 0) {
        cmdResult = await withChannels(
          this.ctx,
          channelRedirections.channels,
          () =>
            executeAndPumpResult(
              this.ctx,
              () => Promise.resolve(cmdResult),
              outputFds,
            ),
        );
      }

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
    } finally {
      // Restore temp assignments even when the command throws (break/continue,
      // exit, abort, safety limits) — otherwise `FOO=bar cmd` leaks FOO into
      // the enclosing environment.
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

    const currentChannels = this.ctx.outputChannels;
    const compiled = await compileOutputRedirections(
      this.ctx,
      currentChannels,
      node.redirections,
    );
    if (compiled.error) {
      return withChannels(this.ctx, compiled.channels, () =>
        executeAndPumpResult(this.ctx, () =>
          Promise.resolve(compiled.error as ExecResult),
        ),
      );
    }

    const outputFds = ([1, 2] as const).filter((fd) => {
      const before = currentChannels.bindings.get(fd);
      const after = compiled.channels.bindings.get(fd);
      return (
        before?.sink !== after?.sink ||
        isChannelClosed(currentChannels, fd) !==
          isChannelClosed(compiled.channels, fd)
      );
    });
    return withChannels(this.ctx, compiled.channels, async () => {
      let bodyResult: ExecResult;
      try {
        const arithResult = await evaluateArithmetic(
          this.ctx,
          node.expression.expression,
        );
        bodyResult = testResult(arithResult !== 0);
      } catch (error) {
        bodyResult = failure(
          `bash: arithmetic expression: ${(error as Error).message}\n`,
        );
      }
      return outputFds.length > 0
        ? executeAndPumpResult(
            this.ctx,
            () => Promise.resolve(bodyResult),
            outputFds,
          )
        : bodyResult;
    });
  }

  private async executeConditionalCommand(
    node: ConditionalCommandNode,
  ): Promise<ExecResult> {
    if (node.line !== undefined) {
      this.ctx.state.currentLine = node.line;
    }

    const currentChannels = this.ctx.outputChannels;
    const compiled = await compileOutputRedirections(
      this.ctx,
      currentChannels,
      node.redirections,
    );
    if (compiled.error) {
      return withChannels(this.ctx, compiled.channels, () =>
        executeAndPumpResult(this.ctx, () =>
          Promise.resolve(compiled.error as ExecResult),
        ),
      );
    }

    const outputFds = ([1, 2] as const).filter((fd) => {
      const before = currentChannels.bindings.get(fd);
      const after = compiled.channels.bindings.get(fd);
      return (
        before?.sink !== after?.sink ||
        isChannelClosed(currentChannels, fd) !==
          isChannelClosed(compiled.channels, fd)
      );
    });
    return withChannels(this.ctx, compiled.channels, async () => {
      let bodyResult: ExecResult;
      try {
        const condResult = await evaluateConditional(this.ctx, node.expression);
        bodyResult = testResult(condResult);
      } catch (error) {
        const exitCode = error instanceof ArithmeticError ? 1 : 2;
        bodyResult = failure(
          `bash: conditional expression: ${(error as Error).message}\n`,
          exitCode,
        );
      }
      return outputFds.length > 0
        ? executeAndPumpResult(
            this.ctx,
            () => Promise.resolve(bodyResult),
            outputFds,
          )
        : bodyResult;
    });
  }
}
