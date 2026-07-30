import { describe, expect, it } from "vitest";
import { Bash, type BashLogger } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { toText } from "../test-utils.js";
import { decode, encode } from "../utils/bytes.js";
import { emptyStream, fromChunks } from "../utils/stream.js";
import {
  type OutputChannels,
  type OutputSink,
  withChannels,
} from "./output-channels.js";
import type { InterpreterContext } from "./types.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("root output channels", () => {
  it("observes a chunk before the next gated chunk is released", async () => {
    const releaseSecond = deferred();
    const firstObserved = deferred();
    let pullCount = 0;
    let observed = "";
    let execResolved = false;
    const command = defineCommand("gated-output", async () => ({
      stdout: new ReadableStream<Uint8Array>({
        async pull(controller) {
          pullCount++;
          if (pullCount === 1) {
            controller.enqueue(encode("A"));
            return;
          }
          await releaseSecond.promise;
          controller.enqueue(encode("B"));
          controller.close();
        },
      }),
      stderr: emptyStream(),
      exitCode: 0,
    }));
    const bash = new Bash({ customCommands: [command] });

    const pending = bash
      .exec("gated-output", {
        stdoutSink: {
          write(chunk) {
            observed += decode(chunk);
            firstObserved.resolve();
          },
        },
      })
      .then((result) => {
        execResolved = true;
        return result;
      });

    await firstObserved.promise;
    expect({ observed, execResolved }).toEqual({
      observed: "A",
      execResolved: false,
    });

    releaseSecond.resolve();
    const result = await toText(await pending);
    expect({
      observed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observed: "AB",
      stdout: "AB",
      stderr: "",
      exitCode: 0,
    });
  });

  it("awaits an async sink and preserves chunk order", async () => {
    const firstWriteStarted = deferred();
    const releaseFirstWrite = deferred();
    const command = defineCommand("chunked-output", async () => ({
      stdout: fromChunks([encode("A"), encode("B"), encode("C")]),
      stderr: emptyStream(),
      exitCode: 0,
    }));
    const bash = new Bash({ customCommands: [command] });
    let observed = "";
    let writeCount = 0;
    let execResolved = false;

    const pending = bash
      .exec("chunked-output", {
        stdoutSink: {
          async write(chunk) {
            writeCount++;
            if (writeCount === 1) {
              firstWriteStarted.resolve();
              await releaseFirstWrite.promise;
            }
            observed += decode(chunk);
          },
        },
      })
      .then((result) => {
        execResolved = true;
        return result;
      });

    await firstWriteStarted.promise;
    expect({ observed, writeCount, execResolved }).toEqual({
      observed: "",
      writeCount: 1,
      execResolved: false,
    });

    releaseFirstWrite.resolve();
    const result = await toText(await pending);
    expect({
      observed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observed: "ABC",
      stdout: "ABC",
      stderr: "",
      exitCode: 0,
    });
  });

  it("returns exactly the delivered chunks when aborted during pumping", async () => {
    const abortController = new AbortController();
    let observed = "";
    let cancelled = false;
    const command = defineCommand("abort-output", async () => ({
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encode("before\n"));
        },
        cancel() {
          cancelled = true;
        },
      }),
      stderr: emptyStream(),
      exitCode: 0,
    }));
    const bash = new Bash({ customCommands: [command] });

    const result = await toText(
      await bash.exec("abort-output", {
        signal: abortController.signal,
        stdoutSink: {
          write(chunk) {
            observed += decode(chunk);
            abortController.abort();
          },
        },
      }),
    );

    expect({
      observed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      cancelled,
    }).toEqual({
      observed: "before\n",
      stdout: "before\n",
      stderr: "",
      exitCode: 143,
      cancelled: true,
    });
  });

  it("keeps logger, host sinks, and returned streams byte-identical", async () => {
    const script = "echo a; echo b >&2; echo c";
    const logs: Array<{
      level: string;
      message: string;
      data?: Record<string, unknown>;
    }> = [];
    const logger: BashLogger = {
      info(message, data) {
        logs.push({ level: "info", message, data });
      },
      debug(message, data) {
        logs.push({ level: "debug", message, data });
      },
    };
    let observedStdout = "";
    let observedStderr = "";
    const bash = new Bash({ logger });

    const result = await toText(
      await bash.exec(script, {
        stdoutSink: {
          write(chunk) {
            observedStdout += decode(chunk);
          },
        },
        stderrSink: {
          write(chunk) {
            observedStderr += decode(chunk);
          },
        },
      }),
    );

    expect({
      observedStdout,
      observedStderr,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      logs,
    }).toEqual({
      observedStdout: "a\nc\n",
      observedStderr: "b\n",
      stdout: "a\nc\n",
      stderr: "b\n",
      exitCode: 0,
      logs: [
        { level: "info", message: "exec", data: { command: script } },
        { level: "debug", message: "stdout", data: { output: "a\nc\n" } },
        { level: "info", message: "stderr", data: { output: "b\n" } },
        { level: "info", message: "exit", data: { exitCode: 0 } },
      ],
    });
  });

  it("preserves output and exit codes when no sinks are provided", async () => {
    const bash = new Bash();
    const cases = [
      {
        script: "echo plain",
        expected: { stdout: "plain\n", stderr: "", exitCode: 0 },
      },
      {
        script: "echo piped | tr a-z A-Z",
        expected: { stdout: "PIPED\n", stderr: "", exitCode: 0 },
      },
      {
        script:
          "for item in one two; do echo loop:$item; done; echo error >&2; false",
        expected: {
          stdout: "loop:one\nloop:two\n",
          stderr: "error\n",
          exitCode: 1,
        },
      },
    ];

    for (const { script, expected } of cases) {
      const { stdout, stderr, exitCode } = await toText(
        await bash.exec(script),
      );
      expect({ stdout, stderr, exitCode }).toEqual(expected);
    }
  });

  it("rejects loudly when an observer write rejects", async () => {
    const failure = new RangeError("observer failed");
    const sink: OutputSink = {
      write() {
        return Promise.reject(failure);
      },
    };

    await expect(
      new Bash().exec("echo unreachable", { stdoutSink: sink }),
    ).rejects.toBe(failure);
  });

  it("restores the prior channels when scoped execution rejects", async () => {
    const original: OutputChannels = { bindings: new Map() };
    const replacement: OutputChannels = { bindings: new Map() };
    const ctx = { outputChannels: original } as InterpreterContext;
    const failure = new Error("scoped failure");

    await expect(
      withChannels(ctx, replacement, async () => {
        expect(ctx.outputChannels).toBe(replacement);
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(ctx.outputChannels).toBe(original);
  });
});
