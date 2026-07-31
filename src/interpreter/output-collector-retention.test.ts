import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { ProcessTable } from "../process/process-table.js";
import { toText } from "../test-utils.js";
import type { BashExecResult } from "../types.js";
import { encode } from "../utils/bytes.js";
import { collectText, emptyStream } from "../utils/stream.js";
import { createCollector, type OutputCollector } from "./output-channels.js";

interface BashCollectorProbe {
  logResult(
    result: Pick<BashExecResult, "exitCode" | "env">,
    stdoutCollector: OutputCollector,
    stderrCollector: OutputCollector,
  ): BashExecResult;
}

describe("OutputCollector retention lifecycle", () => {
  it("releases a snapshot on seal and forwards later writes without retaining them", async () => {
    let forwardedBytes = 0;
    let forwardedWrites = 0;
    const collector = createCollector({
      write(chunk) {
        forwardedBytes += chunk.length;
        forwardedWrites++;
      },
    });

    await collector.write(encode("first"));
    const retainedAfterFirstWrite = collector.retainedByteLength;
    await collector.write(encode("second!"));
    const retainedAfterSecondWrite = collector.retainedByteLength;
    const snapshot = collector.stream();
    const retainedAfterSnapshot = collector.retainedByteLength;

    collector.seal();
    const retainedAfterSeal = collector.retainedByteLength;
    collector.seal();

    const chunk = encode("x".repeat(64 * 1024));
    for (let i = 0; i < 32; i++) {
      await collector.write(chunk);
    }

    expect({
      retainedByteLengths: [
        retainedAfterFirstWrite,
        retainedAfterSecondWrite,
        retainedAfterSnapshot,
        retainedAfterSeal,
        collector.retainedByteLength,
      ],
      snapshot: await collectText(snapshot),
      postSealSnapshot: await collectText(collector.stream()),
      forwardedBytes,
      forwardedWrites,
    }).toEqual({
      retainedByteLengths: [5, 12, 12, 0, 0],
      snapshot: "firstsecond!",
      postSealSnapshot: "",
      forwardedBytes: 2 * 1024 * 1024 + 12,
      forwardedWrites: 34,
    });
  });

  it("keeps root retention flat while a background job streams after exec returns", async () => {
    const chunk = encode("x".repeat(1024));
    const totalChunks = 64;
    const halfwayChunk = totalChunks / 2;

    let startProducing = () => {};
    const startGate = new Promise<void>((resolve) => {
      startProducing = resolve;
    });
    let finishProducing = () => {};
    const halfwayGate = new Promise<void>((resolve) => {
      finishProducing = resolve;
    });
    let emittedChunks = 0;
    const producer = defineCommand("retention-producer", async () => ({
      stdout: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (emittedChunks === 0) {
            await startGate;
          }
          if (emittedChunks === halfwayChunk) {
            await halfwayGate;
          }
          if (emittedChunks === totalChunks) {
            controller.close();
            return;
          }
          controller.enqueue(chunk);
          emittedChunks++;
        },
      }),
      stderr: emptyStream(),
      exitCode: 0,
    }));

    let observedChunks = 0;
    let observedBytes = 0;
    let halfwayObserved = () => {};
    const halfwayObservedGate = new Promise<void>((resolve) => {
      halfwayObserved = resolve;
    });
    let forwardedChunks = 0;
    let forwardedBytes = 0;
    let halfwayForwarded = () => {};
    const halfwayForwardedGate = new Promise<void>((resolve) => {
      halfwayForwarded = resolve;
    });
    const processes = new ProcessTable({
      onJobOutput: (_pid, _fd, outputChunk) => {
        observedChunks++;
        observedBytes += outputChunk.length;
        if (observedChunks === halfwayChunk) {
          halfwayObserved();
        }
      },
    });
    const bash = new Bash({ customCommands: [producer], processes });
    const bashProbe = bash as unknown as BashCollectorProbe;
    const originalLogResult = bashProbe.logResult;
    let rootStdoutCollector: OutputCollector | undefined;
    let rootStderrCollector: OutputCollector | undefined;
    bashProbe.logResult = (result, stdoutCollector, stderrCollector) => {
      rootStdoutCollector = stdoutCollector;
      rootStderrCollector = stderrCollector;
      return originalLogResult.call(
        bashProbe,
        result,
        stdoutCollector,
        stderrCollector,
      );
    };

    const result = await toText(
      await bash.exec("retention-producer &", {
        stdoutSink: {
          write(outputChunk) {
            forwardedChunks++;
            forwardedBytes += outputChunk.length;
            if (forwardedChunks === halfwayChunk) {
              halfwayForwarded();
            }
          },
        },
      }),
    );
    if (!rootStdoutCollector || !rootStderrCollector) {
      throw new Error("Bash.exec did not expose its root collectors");
    }

    expect({
      result: {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      },
      jobState: processes.get(1000)?.state,
      observedChunks,
      observedBytes,
      forwardedChunks,
      forwardedBytes,
      retainedStdoutBytes: rootStdoutCollector.retainedByteLength,
      retainedStderrBytes: rootStderrCollector.retainedByteLength,
    }).toEqual({
      result: {
        stdout: "",
        stderr: "",
        exitCode: 0,
      },
      jobState: "running",
      observedChunks: 0,
      observedBytes: 0,
      forwardedChunks: 0,
      forwardedBytes: 0,
      retainedStdoutBytes: 0,
      retainedStderrBytes: 0,
    });

    startProducing();
    await Promise.all([halfwayObservedGate, halfwayForwardedGate]);

    expect({
      jobState: processes.get(1000)?.state,
      emittedChunks,
      observedChunks,
      observedBytes,
      forwardedChunks,
      forwardedBytes,
      retainedStdoutBytes: rootStdoutCollector.retainedByteLength,
    }).toEqual({
      jobState: "running",
      emittedChunks: 32,
      observedChunks: 32,
      observedBytes: 32 * 1024,
      forwardedChunks: 32,
      forwardedBytes: 32 * 1024,
      retainedStdoutBytes: 0,
    });

    finishProducing();
    const jobExitCode = await processes.wait(1000);

    expect({
      jobExitCode,
      jobState: processes.get(1000)?.state,
      emittedChunks,
      observedChunks,
      observedBytes,
      forwardedChunks,
      forwardedBytes,
      countsMatch: {
        chunks: observedChunks === forwardedChunks,
        bytes: observedBytes === forwardedBytes,
      },
      retainedStdoutBytes: rootStdoutCollector.retainedByteLength,
    }).toEqual({
      jobExitCode: 0,
      jobState: undefined,
      emittedChunks: 64,
      observedChunks: 64,
      observedBytes: 64 * 1024,
      forwardedChunks: 64,
      forwardedBytes: 64 * 1024,
      countsMatch: {
        chunks: true,
        bytes: true,
      },
      retainedStdoutBytes: 0,
    });
  });
});
