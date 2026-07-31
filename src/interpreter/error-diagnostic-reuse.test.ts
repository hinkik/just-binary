import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";
import { ExecutionLimitError } from "./errors.js";

describe("control-flow diagnostic reuse", () => {
  it("reports a reused error once for every throw and execution", async () => {
    const sharedError = new ExecutionLimitError("shared limit", "iterations");
    const bash = new Bash({
      customCommands: [
        defineCommand("limit", async () => {
          throw sharedError;
        }),
      ],
    });
    let observedStderr = "";
    const stderrSink = {
      write(chunk: Uint8Array) {
        observedStderr += decode(chunk);
      },
    };

    const first = await toText(await bash.exec("limit", { stderrSink }));
    const second = await toText(await bash.exec("limit", { stderrSink }));

    expect({
      firstStdout: first.stdout,
      firstStderr: first.stderr,
      firstExitCode: first.exitCode,
      secondStdout: second.stdout,
      secondStderr: second.stderr,
      secondExitCode: second.exitCode,
      observedStderr,
    }).toEqual({
      firstStdout: "",
      firstStderr: "bash: shared limit\n",
      firstExitCode: 126,
      secondStdout: "",
      secondStderr: "bash: shared limit\n",
      secondExitCode: 126,
      observedStderr: "bash: shared limit\nbash: shared limit\n",
    });
  });
});
