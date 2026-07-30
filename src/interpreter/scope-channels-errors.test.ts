import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";

interface ExpectedExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface ErrorCase extends ExpectedExecution {
  name: string;
  script: string;
}

async function executeObserved(script: string): Promise<
  ExpectedExecution & {
    observedStdout: string;
    observedStderr: string;
  }
> {
  let observedStdout = "";
  let observedStderr = "";
  const result = await toText(
    await new Bash({ cwd: "/" }).exec(script, {
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
  };
}

const carryingThrowCases: ErrorCase[] = [
  {
    name: "subshell exit",
    script:
      "(echo subshell-out; echo subshell-error >&2; exit 5); echo status:$?",
    stdout: "subshell-out\nstatus:5\n",
    stderr: "subshell-error\n",
    exitCode: 0,
  },
  {
    name: "function return",
    script:
      "f() { echo function-out; echo function-error >&2; return 3; }; f; echo status:$?",
    stdout: "function-out\nstatus:3\n",
    stderr: "function-error\n",
    exitCode: 0,
  },
  {
    name: "group errexit",
    script:
      "set -e; { echo group-out; echo group-error >&2; false; echo never; }",
    stdout: "group-out\n",
    stderr: "group-error\n",
    exitCode: 1,
  },
];

describe("scope channel error paths", () => {
  it.each(
    carryingThrowCases,
  )("delivers pre-throw bytes once for $name", async ({
    exitCode,
    script,
    stderr,
    stdout,
  }) => {
    expect(await executeObserved(script)).toEqual({
      observedStdout: stdout,
      observedStderr: stderr,
      stdout,
      stderr,
      exitCode,
    });
  });

  it("keeps redirected throw bytes scoped and restores outer channels", async () => {
    expect(
      await executeObserved(`
        (echo subshell-out; echo subshell-error >&2; exit 5) > /sub 2>&1
        echo after-subshell

        f() {
          echo function-out
          echo function-error >&2
          return 3
        } > /function 2>&1
        f
        echo after-function

        (set -e; {
          echo group-out
          echo group-error >&2
          false
          echo never
        } > /group 2>&1)
        echo after-group
        cat /sub /function /group
      `),
    ).toEqual({
      observedStdout:
        "after-subshell\n" +
        "after-function\n" +
        "after-group\n" +
        "subshell-out\n" +
        "subshell-error\n" +
        "function-out\n" +
        "function-error\n" +
        "group-out\n" +
        "group-error\n",
      observedStderr: "",
      stdout:
        "after-subshell\n" +
        "after-function\n" +
        "after-group\n" +
        "subshell-out\n" +
        "subshell-error\n" +
        "function-out\n" +
        "function-error\n" +
        "group-out\n" +
        "group-error\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("pumps SubshellExitError bytes before resuming the outer loop", async () => {
    expect(
      await executeObserved(`
        for i in one; do
          (echo subshell-out; echo subshell-error >&2; break; echo never)
          echo after
        done
      `),
    ).toEqual({
      observedStdout: "subshell-out\nafter\n",
      observedStderr: "subshell-error\n",
      stdout: "subshell-out\nafter\n",
      stderr: "subshell-error\n",
      exitCode: 0,
    });
  });

  it("pumps PosixFatalError bytes once through a group", async () => {
    expect(
      await executeObserved(`
        set -o posix
        { echo group-out; echo group-error >&2; shift 1; echo never; }
      `),
    ).toEqual({
      observedStdout: "group-out\n",
      observedStderr: "group-error\nbash: shift: shift count out of range\n",
      stdout: "group-out\n",
      stderr: "group-error\nbash: shift: shift count out of range\n",
      exitCode: 1,
    });
  });

  it("keeps compgen's failure stderr in its capture adapter", async () => {
    expect(
      await executeObserved(`
        _complete() {
          echo completion-error >&2
          return 1
        }
        compgen -F _complete
      `),
    ).toEqual({
      observedStdout: "",
      observedStderr: "completion-error\n",
      stdout: "",
      stderr: "completion-error\n",
      exitCode: 1,
    });
  });
});
