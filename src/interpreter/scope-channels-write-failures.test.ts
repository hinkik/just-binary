import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { toText } from "../test-utils.js";
import { fromString } from "../utils/stream.js";
import { ExecutionLimitError } from "./errors.js";

function legacyThrowingCommand() {
  return defineCommand("legacy-throw", async () => {
    throw new ExecutionLimitError(
      "legacy boundary failed",
      "iterations",
      fromString("legacy-out\n"),
      fromString("legacy-error\n"),
    );
  });
}

const expectedError =
  "legacy-error\n" +
  "bash: legacy boundary failed\n" +
  "bash: echo: write error: No space left on device\n";

describe("scope channel write failures", () => {
  it.each([
    {
      name: "group",
      script: "{ legacy-throw; } > /dev/full 2> /write-error",
    },
    {
      name: "subshell",
      script: "(legacy-throw) > /dev/full 2> /write-error",
    },
    {
      name: "function definition",
      script: "f() { legacy-throw; } > /dev/full 2> /write-error; f",
    },
  ])("converts a carried-stream failure inside a $name table", async ({
    script,
  }) => {
    const bash = new Bash({
      cwd: "/",
      customCommands: [legacyThrowingCommand()],
    });
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
      file: expectedError,
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
