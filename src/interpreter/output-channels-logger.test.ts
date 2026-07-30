import { describe, expect, it } from "vitest";
import { Bash, type BashLogger } from "../Bash.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";

describe("root output channel logger", () => {
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

    const streamedResult = await bash.exec(script, {
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
    });

    expect(logs).toEqual([
      { level: "info", message: "exec", data: { command: script } },
      { level: "debug", message: "stdout", data: { output: "a\nc\n" } },
      { level: "info", message: "stderr", data: { output: "b\n" } },
      { level: "info", message: "exit", data: { exitCode: 0 } },
    ]);

    const result = await toText(streamedResult);
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
});
