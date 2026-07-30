import type { ExecResult } from "../types.js";
import { encode } from "../utils/bytes.js";
import {
  type ByteStream,
  emptyStream,
  fromChunks,
  fromString,
} from "../utils/stream.js";
import { checkAborted } from "./errors.js";
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

interface OutputCollector extends OutputSink {
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
): Promise<void> {
  const bytes = typeof chunk === "string" ? encode(chunk) : chunk;
  if (bytes.length > 0) {
    await channelSink(ctx.outputChannels, fd, false).write(bytes);
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
  const pumps: Promise<void>[] = [];
  if (outputFds.includes(1)) {
    pumps.push(
      pumpStream(
        ctx,
        result.stdout,
        channelSink(ctx.outputChannels, 1),
        checkSignal,
      ),
    );
  }
  if (outputFds.includes(2)) {
    pumps.push(
      pumpStream(
        ctx,
        result.stderr,
        channelSink(ctx.outputChannels, 2),
        checkSignal,
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

interface OutputCarryingError {
  stdout: ByteStream;
  stderr: ByteStream;
}

function carriesOutput(error: unknown): error is OutputCarryingError {
  return (
    error instanceof Error &&
    "stdout" in error &&
    "stderr" in error &&
    error.stdout instanceof ReadableStream &&
    error.stderr instanceof ReadableStream
  );
}

/**
 * Move streams carried by a legacy control-flow error into the active table.
 *
 * Abort checks are disabled while draining because an AbortExecutionError is
 * handled only after its signal has fired; the finite output already produced
 * before cancellation still has to reach the current sinks exactly once.
 */
export async function pumpErrorStreams(
  ctx: InterpreterContext,
  error: unknown,
  outputFds: readonly (1 | 2)[] = [1, 2],
): Promise<boolean> {
  if (!carriesOutput(error)) {
    return false;
  }

  const stdout = error.stdout;
  const stderr = error.stderr;
  const pumps: Promise<void>[] = [];
  if (outputFds.includes(1)) {
    pumps.push(
      pumpStream(ctx, stdout, channelSink(ctx.outputChannels, 1), false),
    );
  }
  if (outputFds.includes(2)) {
    pumps.push(
      pumpStream(ctx, stderr, channelSink(ctx.outputChannels, 2), false),
    );
  }
  const settled = await Promise.allSettled(pumps);
  if (outputFds.includes(1)) {
    error.stdout = emptyStream();
  }
  if (outputFds.includes(2)) {
    error.stderr = emptyStream();
  }

  const rejected = settled.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (rejected) {
    throw rejected.reason;
  }
  return outputFds.length > 0;
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

export async function pumpErrorStreamsWithWriteFailure(
  ctx: InterpreterContext,
  error: unknown,
  outputFds?: readonly (1 | 2)[],
): Promise<{
  writeFailure: ExecResult | null;
  carriedOutput: boolean;
}> {
  try {
    const carriedOutput = await pumpErrorStreams(ctx, error, outputFds);
    return isNoSpaceError(error) || isBadFileDescriptorError(error)
      ? {
          writeFailure: await reportWriteFailure(ctx, error),
          carriedOutput,
        }
      : { writeFailure: null, carriedOutput };
  } catch (pumpError) {
    if (isNoSpaceError(pumpError) || isBadFileDescriptorError(pumpError)) {
      return {
        writeFailure: await reportWriteFailure(ctx, pumpError),
        carriedOutput: true,
      };
    }
    throw pumpError;
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
    const { carriedOutput, writeFailure } =
      await pumpErrorStreamsWithWriteFailure(ctx, error);
    if (writeFailure) {
      return writeFailure;
    }
    if (isNoSpaceError(error) || isBadFileDescriptorError(error)) {
      return carriedOutput
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
