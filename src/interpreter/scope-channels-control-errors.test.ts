import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import type { InitialFiles } from "../fs/interface.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";

interface ExitBoundaryCase {
  name: string;
  script: string;
  files: InitialFiles;
  exitCode: number;
  file: string;
}

const exitBoundaryCases: ExitBoundaryCase[] = [
  {
    name: "eval",
    script: "eval 'echo eval-out; echo eval-error >&2; exit 7' > /error 2>&1",
    files: {},
    exitCode: 7,
    file: "eval-out\neval-error\n",
  },
  {
    name: "source",
    script: "source /exit-source > /error 2>&1",
    files: {
      "/exit-source": "echo source-out; echo source-error >&2; exit 8",
    },
    exitCode: 8,
    file: "source-out\nsource-error\n",
  },
  {
    name: "user script",
    script: "/exit-script > /error 2>&1",
    files: {
      "/exit-script": {
        content: "#!/bin/bash\necho script-out\necho script-error >&2\nexit 9",
        mode: 0o755,
      },
    },
    exitCode: 9,
    file: "script-out\nscript-error\n",
  },
];

async function executeObserved(
  script: string,
  files?: InitialFiles,
): Promise<{
  observedStdout: string;
  observedStderr: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  bash: Bash;
}> {
  let observedStdout = "";
  let observedStderr = "";
  const bash = new Bash({ cwd: "/", files });
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
  return {
    observedStdout,
    observedStderr,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    bash,
  };
}

describe("scope channel boundary control errors", () => {
  it.each(
    exitBoundaryCases,
  )("keeps redirected $name ExitError bytes inside its live table", async ({
    exitCode,
    file,
    files,
    script,
  }) => {
    const execution = await executeObserved(script, files);
    expect({
      observedStdout: execution.observedStdout,
      observedStderr: execution.observedStderr,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
      file: await execution.bash.fs.readFileText("/error"),
    }).toEqual({
      observedStdout: "",
      observedStderr: "",
      stdout: "",
      stderr: "",
      exitCode,
      file,
    });
  });

  it("propagates eval ReturnError after pumping its redirected bytes", async () => {
    const execution = await executeObserved(`
      f() {
        eval 'echo eval-out; echo eval-error >&2; return 4' > /eval-return 2>&1
        echo never
      }
      f
      printf 'status:%s\\n' "$?"
      cat /eval-return
    `);

    expect({
      observedStdout: execution.observedStdout,
      observedStderr: execution.observedStderr,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
    }).toEqual({
      observedStdout: "status:4\neval-out\neval-error\n",
      observedStderr: "",
      stdout: "status:4\neval-out\neval-error\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("converts source ReturnError after pumping its redirected bytes", async () => {
    const execution = await executeObserved(
      `
        source /return-source > /source-return 2>&1
        printf 'status:%s\\n' "$?"
        cat /source-return
      `,
      {
        "/return-source":
          "echo source-out; echo source-error >&2; return 6; echo never",
      },
    );

    expect({
      observedStdout: execution.observedStdout,
      observedStderr: execution.observedStderr,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
    }).toEqual({
      observedStdout: "status:6\nsource-out\nsource-error\n",
      observedStderr: "",
      stdout: "status:6\nsource-out\nsource-error\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("translates PosixFatalError inside a redirected subshell", async () => {
    const execution = await executeObserved(`
      set -o posix
      (echo subshell-out; echo subshell-error >&2; shift 1) > /posix 2>&1
      printf 'status:%s\\n' "$?"
      cat /posix
    `);

    expect({
      observedStdout: execution.observedStdout,
      observedStderr: execution.observedStderr,
      stdout: execution.stdout,
      stderr: execution.stderr,
      exitCode: execution.exitCode,
    }).toEqual({
      observedStdout:
        "status:1\nsubshell-out\nsubshell-error\nbash: shift: shift count out of range\n",
      observedStderr: "",
      stdout:
        "status:1\nsubshell-out\nsubshell-error\nbash: shift: shift count out of range\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
