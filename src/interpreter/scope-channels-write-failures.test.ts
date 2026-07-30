import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { toText } from "../test-utils.js";
import { ExecutionLimitError } from "./errors.js";

function diagnosticThrowingCommand() {
  return defineCommand("diagnostic-limit", async () => {
    throw new ExecutionLimitError("diagnostic failed", "iterations");
  });
}

describe("scope channel write failures", () => {
  it.each([
    {
      name: "group",
      script: "{ diagnostic-limit; } 2> /dev/full",
    },
    {
      name: "subshell",
      script: "(diagnostic-limit) 2> /dev/full",
    },
    {
      name: "function definition",
      script: "f() { diagnostic-limit; } 2> /dev/full; f",
    },
  ])("converts a failed diagnostic write through a $name table", async ({
    script,
  }) => {
    const result = await toText(
      await new Bash({
        cwd: "/",
        customCommands: [diagnosticThrowingCommand()],
      }).exec(script),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 1,
    });
  });

  it.each([
    {
      name: "group",
      script: "{ echo hi; } > /dev/full 2> /write-error",
    },
    {
      name: "subshell",
      script: "(echo hi) > /dev/full 2> /write-error",
    },
    {
      name: "function definition",
      script: "f() { echo hi; } > /dev/full 2> /write-error; f",
    },
  ])("preserves a normal write-failure status through a $name", async ({
    script,
  }) => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(await bash.exec(script));

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/write-error"),
    }).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 1,
      file: "bash: echo: write error: No space left on device\n",
    });
  });
});
