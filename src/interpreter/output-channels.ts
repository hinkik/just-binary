import type { ExecResult } from "../types.js";
import { type ByteStream, emptyStream, fromChunks } from "../utils/stream.js";
import { checkAborted } from "./errors.js";
import type { InterpreterContext } from "./types.js";

export interface OutputSink {
  /** Implementations must serialize writes (fd 1 and fd 2 may alias one sink after 2>&1). */
  write(chunk: Uint8Array): void | Promise<void>;
}

export type OutputChannels = Map<number, OutputSink>;

export interface OutputCollector extends OutputSink {
  /** Valid after all writes for the execution have settled. */
  stream(): ByteStream;
}

const discardSink: OutputSink = {
  write() {},
};

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
): Promise<void> {
  const reader = stream.getReader();
  let finished = false;
  try {
    while (true) {
      checkAborted(ctx.signal);
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        break;
      }
      if (!value || value.length === 0) {
        continue;
      }
      await sink.write(value);
      checkAborted(ctx.signal);
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
): Promise<ExecResult> {
  const settled = await Promise.allSettled([
    pumpStream(ctx, result.stdout, ctx.outputChannels.get(1) ?? discardSink),
    pumpStream(ctx, result.stderr, ctx.outputChannels.get(2) ?? discardSink),
  ]);
  const rejected = settled.find(
    (outcome): outcome is PromiseRejectedResult =>
      outcome.status === "rejected",
  );
  if (rejected) {
    throw rejected.reason;
  }

  return {
    ...result,
    stdout: emptyStream(),
    stderr: emptyStream(),
  };
}
