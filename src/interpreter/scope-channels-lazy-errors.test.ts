import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import type { InitialFiles } from "../fs/interface.js";
import { toText } from "../test-utils.js";
import { decode, encode } from "../utils/bytes.js";
import { emptyStream } from "../utils/stream.js";
import { ExecutionLimitError } from "./errors.js";

function lazyFailingInput() {
  return defineCommand("lazy-failing-input", async () => {
    const error = new ExecutionLimitError("lazy input failed", "iterations");
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

function throwingCommand() {
  return defineCommand("throw-limit", async () => {
    throw new ExecutionLimitError("boundary failed", "iterations");
  });
}

interface BoundaryCase {
  name: string;
  script: string;
  files: InitialFiles;
}

const boundaryCases: BoundaryCase[] = [
  {
    name: "group",
    script:
      "{ echo boundary-out; echo boundary-error >&2; throw-limit; } > /boundary-error 2>&1",
    files: {},
  },
  {
    name: "eval",
    script:
      "eval 'echo boundary-out; echo boundary-error >&2; throw-limit' > /boundary-error 2>&1",
    files: {},
  },
  {
    name: "source",
    script: "source /throwing-source > /boundary-error 2>&1",
    files: {
      "/throwing-source":
        "echo boundary-out; echo boundary-error >&2; throw-limit",
    },
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
      observedStdout: "",
      observedStderr: "bash: lazy input failed\n",
      stdout: "",
      stderr: "bash: lazy input failed\n",
      exitCode: 126,
    });
  });

  it("preserves a lazy prefix before the stream failure diagnostic", async () => {
    const error = new ExecutionLimitError("lazy prefix failed", "iterations");
    let pulled = false;
    const command = defineCommand("lazy-prefix", async () => ({
      stdout: new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!pulled) {
            pulled = true;
            controller.enqueue(encode("prefix\n"));
            return;
          }
          controller.error(error);
        },
      }),
      stderr: emptyStream(),
      exitCode: 0,
    }));
    let observedStdout = "";
    let observedStderr = "";

    const result = await toText(
      await new Bash({ customCommands: [command] }).exec("lazy-prefix | cat", {
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
    }).toEqual({
      observedStdout: "prefix\n",
      observedStderr: "bash: lazy prefix failed\n",
      stdout: "prefix\n",
      stderr: "bash: lazy prefix failed\n",
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
      file: "bash: lazy input failed\n",
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
      file: "bash: lazy input failed\n",
      followup: { stdout: "restored\n", stderr: "", exitCode: 0 },
    });
  });

  it.each(
    boundaryCases,
  )("routes a diagnostic through a redirected $name", async ({
    files,
    script,
  }) => {
    let observedStdout = "";
    let observedStderr = "";
    const bash = new Bash({
      cwd: "/",
      customCommands: [throwingCommand()],
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
      file: "boundary-out\nboundary-error\nbash: boundary failed\n",
    });
  });
});
