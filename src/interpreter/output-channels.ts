import type { ExecResult } from "../types.js";
import { encode } from "../utils/bytes.js";
import {
  type ByteStream,
  emptyStream,
  fromChunks,
  fromString,
} from "../utils/stream.js";
import {
  AbortExecutionError,
  ArithmeticError,
  BadSubstitutionError,
  BraceExpansionError,
  checkAborted,
  ExecutionLimitError,
  GlobError,
  NounsetError,
} from "./errors.js";
import type { InterpreterContext } from "./types.js";

export interface OutputSink {
  /** Implementations must serialize writes (fd 1 and fd 2 may alias one sink after 2>&1). */
  write(chunk: Uint8Array): void | Promise<void>;
}

/** One fd's binding. An absent sink with a descriptor records a closed fd. */
interface ChannelBinding {
  sink?: OutputSink;
  descriptor?: string;
}

export interface OutputChannels {
  bindings: Map<number, ChannelBinding>;
  /** Enclosing table when this one is a temporary redirection scope. */
  parent?: OutputChannels;
  /** Fds whose bindings this temporary scope overrode. */
  overrides?: Set<number>;
}

export interface OutputCollector extends OutputSink {
  /** Decode the accumulated bytes without consuming the collector. */
  text(): string;
  /** Valid after all writes for the execution have settled. */
  stream(): ByteStream;
}

export const CLOSED_CHANNEL_DESCRIPTOR = "__closed__";

export function cloneOutputChannels(channels: OutputChannels): OutputChannels {
  return { bindings: new Map(channels.bindings) };
}

export function overrideChannelSink(
  channels: OutputChannels,
  fd: number,
  sink: OutputSink,
): void {
  channels.bindings.set(fd, { sink });
}

export function hasChannelBinding(
  channels: OutputChannels,
  fd: number,
): boolean {
  let current: OutputChannels | undefined = channels;
  while (current) {
    if (current.bindings.has(fd)) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

export function isChannelClosed(channels: OutputChannels, fd: number): boolean {
  return channels.bindings.get(fd)?.descriptor === CLOSED_CHANNEL_DESCRIPTOR;
}

export function setPersistentChannel(
  channels: OutputChannels,
  fd: number,
  sink: OutputSink | undefined,
  descriptor: string,
): void {
  let current: OutputChannels | undefined = channels;
  while (current) {
    const stopAfterCurrent = current.overrides?.has(fd) === true;
    current.bindings.set(fd, { sink, descriptor });
    if (stopAfterCurrent) {
      return;
    }
    current = current.parent;
  }
}

export function deletePersistentChannel(
  channels: OutputChannels,
  fd: number,
): boolean {
  let current: OutputChannels | undefined = channels;
  while (current) {
    const stopAfterCurrent = current.overrides?.has(fd) === true;
    current.bindings.set(fd, { descriptor: CLOSED_CHANNEL_DESCRIPTOR });
    if (stopAfterCurrent) {
      return false;
    }
    current = current.parent;
  }
  return true;
}

const discardSink: OutputSink = {
  write() {},
};

const closedSink: OutputSink = {
  write() {
    const error = new Error(
      "bash: echo: write error: Bad file descriptor\n",
    ) as Error & { code: string };
    error.code = "EBADF";
    return Promise.reject(error);
  },
};

function channelSink(
  channels: OutputChannels,
  fd: number,
  failClosed = true,
): OutputSink {
  let current: OutputChannels | undefined = channels;
  while (current) {
    const binding = current.bindings.get(fd);
    if (binding) {
      return binding.descriptor === CLOSED_CHANNEL_DESCRIPTOR
        ? failClosed
          ? closedSink
          : discardSink
        : (binding.sink ?? discardSink);
    }
    current = current.parent;
  }
  return discardSink;
}

export async function writeToChannel(
  ctx: InterpreterContext,
  fd: number,
  chunk: Uint8Array | string,
  failClosed = false,
): Promise<void> {
  const bytes = typeof chunk === "string" ? encode(chunk) : chunk;
  if (bytes.length > 0) {
    await channelSink(ctx.outputChannels, fd, failClosed).write(bytes);
  }
}

export function createCollector(forward?: OutputSink): OutputCollector {
  const chunks: Uint8Array[] = [];
  let writeChain = Promise.resolve();

  return {
    write(chunk: Uint8Array): void | Promise<void> {
      chunks.push(forward ? chunk.slice() : chunk);
      if (!forward) {
        return;
      }

      const write = writeChain.then(() => forward.write(chunk));
      writeChain = write.catch(() => undefined);
      return write;
    },
    text(): string {
      const decoder = new TextDecoder();
      let output = "";
      for (const chunk of chunks) {
        if (chunk.length > 0) {
          output += decoder.decode(chunk, { stream: true });
        }
      }
      return output + decoder.decode();
    },
    stream(): ByteStream {
      return fromChunks(chunks);
    },
  };
}

export async function withChannels<T>(
  ctx: InterpreterContext,
  channels: OutputChannels,
  fn: () => T | Promise<T>,
): Promise<T> {
  const previousChannels = ctx.outputChannels;
  ctx.outputChannels = channels;
  try {
    return await fn();
  } finally {
    ctx.outputChannels = previousChannels;
  }
}

export async function pumpStream(
  ctx: InterpreterContext,
  stream: ByteStream,
  sink: OutputSink,
  checkSignal = true,
): Promise<void> {
  if (checkSignal) {
    checkAborted(ctx.signal);
  }
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      if (checkSignal) {
        checkAborted(ctx.signal);
      }
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      await sink.write(value);
      if (checkSignal) {
        checkAborted(ctx.signal);
      }
    }
  } finally {
    if (!finished) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the read, write, or abort failure that caused early exit.
      }
    }
    reader.releaseLock();
  }
}

export async function pumpResult(
  ctx: InterpreterContext,
  result: ExecResult,
  checkSignal = true,
  outputFds: readonly (1 | 2)[] = [1, 2],
): Promise<ExecResult> {
  const childHandledAbort =
    ctx.signal?.aborted === true &&
    result.exitCode === new AbortExecutionError(ctx.signal.reason).exitCode;
  const shouldCheckSignal = checkSignal && !childHandledAbort;
  const pumps: Promise<void>[] = [];
  if (outputFds.includes(1)) {
    pumps.push(
      pumpStream(
        ctx,
        result.stdout,
        channelSink(ctx.outputChannels, 1),
        shouldCheckSignal,
      ),
    );
  }
  if (outputFds.includes(2)) {
    pumps.push(
      pumpStream(
        ctx,
        result.stderr,
        channelSink(ctx.outputChannels, 2),
        shouldCheckSignal,
      ),
    );
  }
  const settled = await Promise.allSettled(pumps);
  const rejected = settled.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (rejected) {
    throw rejected.reason;
  }

  return {
    ...result,
    stdout: outputFds.includes(1) ? emptyStream() : result.stdout,
    stderr: outputFds.includes(2) ? emptyStream() : result.stderr,
  };
}

/**
 * Write a control-flow diagnostic to the active fd 2 exactly once.
 */
export async function writeErrorDiagnostic(
  ctx: InterpreterContext,
  error: unknown,
  outputFds: readonly (1 | 2)[] = [1, 2],
): Promise<boolean> {
  if (
    !(error instanceof Error) ||
    error instanceof AbortExecutionError ||
    !outputFds.includes(2)
  ) {
    return false;
  }

  let diagnostic: string | undefined;
  if (
    error instanceof ExecutionLimitError ||
    error instanceof NounsetError ||
    error instanceof BraceExpansionError
  ) {
    diagnostic = `bash: ${error.message}\n`;
  } else if (error instanceof ArithmeticError && error.reportDiagnostic) {
    diagnostic = `bash: ${error.message}\n`;
  } else if (error instanceof BadSubstitutionError) {
    diagnostic = `bash: ${error.message}: bad substitution\n`;
  } else if (error instanceof GlobError) {
    diagnostic = `bash: no match: ${error.pattern}\n`;
  }

  if (diagnostic === undefined) {
    return false;
  }
  let reportedDiagnostics = ctx.reportedDiagnostics;
  if (!reportedDiagnostics) {
    reportedDiagnostics = new WeakSet();
    ctx.reportedDiagnostics = reportedDiagnostics;
  }
  if (!reportedDiagnostics.has(error)) {
    await channelSink(ctx.outputChannels, 2).write(encode(diagnostic));
    reportedDiagnostics.add(error);
  }
  return true;
}

function isNoSpaceError(error: unknown): error is Error & { code: "ENOSPC" } {
  return error instanceof Error && "code" in error && error.code === "ENOSPC";
}

function isBadFileDescriptorError(
  error: unknown,
): error is Error & { code: "EBADF" } {
  return error instanceof Error && "code" in error && error.code === "EBADF";
}

async function reportWriteFailure(
  ctx: InterpreterContext,
  error: Error,
): Promise<ExecResult> {
  const message = error.message.endsWith("\n")
    ? error.message
    : `${error.message}\n`;
  try {
    await pumpResult(ctx, {
      stdout: emptyStream(),
      stderr: fromString(message),
      exitCode: 1,
    });
  } catch (reportError) {
    if (
      !isNoSpaceError(reportError) &&
      !isBadFileDescriptorError(reportError)
    ) {
      throw reportError;
    }
  }
  return {
    stdout: emptyStream(),
    stderr: emptyStream(),
    exitCode: 1,
  };
}

export async function writeErrorDiagnosticWithWriteFailure(
  ctx: InterpreterContext,
  error: unknown,
  outputFds?: readonly (1 | 2)[],
): Promise<{
  writeFailure: ExecResult | null;
  diagnosticWritten: boolean;
}> {
  try {
    const diagnosticWritten = await writeErrorDiagnostic(ctx, error, outputFds);
    return isNoSpaceError(error) || isBadFileDescriptorError(error)
      ? {
          writeFailure: await reportWriteFailure(ctx, error),
          diagnosticWritten,
        }
      : { writeFailure: null, diagnosticWritten };
  } catch (writeError) {
    if (isNoSpaceError(writeError) || isBadFileDescriptorError(writeError)) {
      return {
        writeFailure: await reportWriteFailure(ctx, writeError),
        diagnosticWritten: true,
      };
    }
    throw writeError;
  }
}

export async function executeAndPumpResult(
  ctx: InterpreterContext,
  execute: () => Promise<ExecResult>,
  outputFds?: readonly (1 | 2)[],
): Promise<ExecResult> {
  try {
    return await pumpResult(ctx, await execute(), true, outputFds);
  } catch (error) {
    const { diagnosticWritten, writeFailure } =
      await writeErrorDiagnosticWithWriteFailure(ctx, error);
    if (writeFailure) {
      return writeFailure;
    }
    if (isNoSpaceError(error) || isBadFileDescriptorError(error)) {
      return diagnosticWritten
        ? {
            stdout: emptyStream(),
            stderr: emptyStream(),
            exitCode: 1,
          }
        : reportWriteFailure(ctx, error);
    }
    throw error;
  }
}
