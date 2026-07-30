import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import type { InitialFiles } from "../fs/interface.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";
import { emptyStream, fromString } from "../utils/stream.js";
import { ExecutionLimitError } from "./errors.js";

function lazyFailingInput() {
  return defineCommand("lazy-failing-input", async () => {
    const error = new ExecutionLimitError(
      "lazy input failed",
      "iterations",
      fromString("legacy-out\n"),
      fromString("legacy-error\n"),
    );
    return {
      stdout: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(error);
        },
      }),
      stderr: emptyStream(),
      exitCode: 0,
    };
  });
}

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

interface LegacyBoundaryCase {
  name: string;
  script: string;
  files: InitialFiles;
}

const legacyBoundaryCases: LegacyBoundaryCase[] = [
  {
    name: "group",
    script: "{ legacy-throw; } > /boundary-error 2>&1",
    files: {},
  },
  {
    name: "eval",
    script: "eval 'legacy-throw' > /boundary-error 2>&1",
    files: {},
  },
  {
    name: "source",
    script: "source /throwing-source > /boundary-error 2>&1",
    files: { "/throwing-source": "legacy-throw" },
  },
];

describe("scope channel lazy-input errors", () => {
  it("pumps a failure through subshell channels once", async () => {
    let observedStdout = "";
    let observedStderr = "";
    const result = await toText(
      await new Bash({ customCommands: [lazyFailingInput()] }).exec(
        "lazy-failing-input | (cat)",
        {
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
        },
      ),
    );

    expect({
      observedStdout,
      observedStderr,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observedStdout: "legacy-out\n",
      observedStderr: "legacy-error\nbash: lazy input failed\n",
      stdout: "legacy-out\n",
      stderr: "legacy-error\nbash: lazy input failed\n",
      exitCode: 126,
    });
  });

  it("routes a failure through function-definition redirects", async () => {
    const bash = new Bash({ cwd: "/", customCommands: [lazyFailingInput()] });
    const result = await toText(
      await bash.exec(
        "f() { cat; } > /function-error 2>&1; lazy-failing-input | f",
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/function-error"),
    }).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 126,
      file: "legacy-out\nlegacy-error\nbash: lazy input failed\n",
    });
  });

  it("restores user-script state after a failure", async () => {
    const bash = new Bash({
      cwd: "/",
      customCommands: [lazyFailingInput()],
      files: {
        "/reader": {
          content: "#!/bin/bash\ncat",
          mode: 0o755,
        },
      },
    });
    const failed = await toText(
      await bash.exec("lazy-failing-input | /reader > /script-error 2>&1"),
    );
    const followup = await toText(await bash.exec("echo restored"));

    expect({
      failed: {
        stdout: failed.stdout,
        stderr: failed.stderr,
        exitCode: failed.exitCode,
      },
      file: await bash.fs.readFileText("/script-error"),
      followup: {
        stdout: followup.stdout,
        stderr: followup.stderr,
        exitCode: followup.exitCode,
      },
    }).toEqual({
      failed: { stdout: "", stderr: "", exitCode: 126 },
      file: "legacy-out\nlegacy-error\nbash: lazy input failed\n",
      followup: { stdout: "restored\n", stderr: "", exitCode: 0 },
    });
  });

  it.each(
    legacyBoundaryCases,
  )("pumps and blanks legacy-carried bytes through a redirected $name", async ({
    files,
    script,
  }) => {
    let observedStdout = "";
    let observedStderr = "";
    const bash = new Bash({
      cwd: "/",
      customCommands: [legacyThrowingCommand()],
      files,
    });
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
      file: await bash.fs.readFileText("/boundary-error"),
    }).toEqual({
      observedStdout: "",
      observedStderr: "",
      stdout: "",
      stderr: "",
      exitCode: 126,
      file: "legacy-out\nlegacy-error\nbash: legacy boundary failed\n",
    });
  });

  it("keeps a carried-stream write failure inside the leaf channel table", async () => {
    const bash = new Bash({
      cwd: "/",
      customCommands: [legacyThrowingCommand()],
    });
    const result = await toText(
      await bash.exec(
        "{ legacy-throw > /dev/full 2> /write-error; } 3> /unused; cat /write-error",
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/write-error"),
    }).toEqual({
      stdout:
        "legacy-error\nbash: legacy boundary failed\nbash: echo: write error: No space left on device\n",
      stderr: "",
      exitCode: 0,
      file: "legacy-error\nbash: legacy boundary failed\nbash: echo: write error: No space left on device\n",
    });
  });
});
