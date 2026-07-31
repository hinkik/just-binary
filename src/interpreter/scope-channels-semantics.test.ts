import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import type { InitialFiles } from "../fs/interface.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";

interface ExpectedExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface BoundaryCase extends ExpectedExecution {
  name: string;
  script: string;
  files?: InitialFiles;
}

async function executeObserved(
  script: string,
  files?: InitialFiles,
): Promise<
  ExpectedExecution & {
    observedStdout: string;
    observedStderr: string;
  }
> {
  let observedStdout = "";
  let observedStderr = "";
  const result = await toText(
    await new Bash({ cwd: "/", files }).exec(script, {
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

const controlFlowCases: BoundaryCase[] = [
  {
    name: "subshell exit",
    script: "(exit 5); echo $?",
    stdout: "5\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "function return",
    script: "f() { return 3; }; f; echo $?",
    stdout: "3\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "group errexit",
    script: "set -e; { false; echo never; }",
    stdout: "",
    stderr: "",
    exitCode: 1,
  },
  {
    name: "group exit",
    script: "{ echo group; exit 7; }",
    stdout: "group\n",
    stderr: "",
    exitCode: 7,
  },
  {
    name: "function exit",
    script: "f() { echo function; exit 8; }; f",
    stdout: "function\n",
    stderr: "",
    exitCode: 8,
  },
  {
    name: "eval exit",
    script: "eval 'echo eval; exit 9'",
    stdout: "eval\n",
    stderr: "",
    exitCode: 9,
  },
  {
    name: "source exit",
    script: "source /exit-source",
    files: { "/exit-source": "echo source; exit 10" },
    stdout: "source\n",
    stderr: "",
    exitCode: 10,
  },
  {
    name: "user script exit",
    script: "/exit-script",
    files: {
      "/exit-script": {
        content: "#!/bin/bash\necho script\nexit 11",
        mode: 0o755,
      },
    },
    stdout: "script\n",
    stderr: "",
    exitCode: 11,
  },
];

describe("scope output channel semantics", () => {
  it("binds compound and function-definition redirects before execution", async () => {
    const bash = new Bash({ cwd: "/" });

    const groupResult = await toText(
      await bash.exec("{ echo a; echo e >&2; } > /group-file 2>&1"),
    );
    const subshellResult = await toText(
      await bash.exec("(echo x) > /subshell-file"),
    );
    const functionResult = await toText(
      await bash.exec(
        "f() { echo fn; } > /function-file; f; cat /function-file",
      ),
    );

    expect({
      group: {
        stdout: groupResult.stdout,
        stderr: groupResult.stderr,
        exitCode: groupResult.exitCode,
        file: await bash.fs.readFileText("/group-file"),
      },
      subshell: {
        stdout: subshellResult.stdout,
        stderr: subshellResult.stderr,
        exitCode: subshellResult.exitCode,
        file: await bash.fs.readFileText("/subshell-file"),
      },
      function: {
        stdout: functionResult.stdout,
        stderr: functionResult.stderr,
        exitCode: functionResult.exitCode,
        file: await bash.fs.readFileText("/function-file"),
      },
    }).toEqual({
      group: {
        stdout: "",
        stderr: "",
        exitCode: 0,
        file: "a\ne\n",
      },
      subshell: {
        stdout: "",
        stderr: "",
        exitCode: 0,
        file: "x\n",
      },
      function: {
        stdout: "fn\n",
        stderr: "",
        exitCode: 0,
        file: "fn\n",
      },
    });
  });

  it("applies explicit <& output duplication to converted scopes", async () => {
    expect(
      await executeObserved(`
        { echo group; } 1<&2
        (echo subshell) 1<&2
        f() { echo function; } 1<&2
        f
      `),
    ).toEqual({
      observedStdout: "",
      observedStderr: "group\nsubshell\nfunction\n",
      stdout: "",
      stderr: "group\nsubshell\nfunction\n",
      exitCode: 0,
    });
  });

  it.each(controlFlowCases)("delivers $name output exactly once", async ({
    exitCode,
    files,
    script,
    stderr,
    stdout,
  }) => {
    expect(await executeObserved(script, files)).toEqual({
      observedStdout: stdout,
      observedStderr: stderr,
      stdout,
      stderr,
      exitCode,
    });
  });

  it("inherits substitution capture channels without host leakage", async () => {
    const result = await executeObserved(`
      value=$(
        (echo subshell; echo subshell-error >&2)
        { echo group; echo group-error >&2; }
        f() { echo function; echo function-error >&2; }
        f
      )
      printf '<%s>\\n' "$value"
    `);

    expect(result).toEqual({
      observedStdout: "<subshell\ngroup\nfunction>\n",
      observedStderr: "subshell-error\ngroup-error\nfunction-error\n",
      stdout: "<subshell\ngroup\nfunction>\n",
      stderr: "subshell-error\ngroup-error\nfunction-error\n",
      exitCode: 0,
    });
  });

  it("hands group and subshell pipeline stages to their consumers", async () => {
    expect(
      await executeObserved(`
        { echo ab; echo cd; } | tr a-z A-Z
        (echo abc; echo xyz) | rev
      `),
    ).toEqual({
      observedStdout: "AB\nCD\ncba\nzyx\n",
      observedStderr: "",
      stdout: "AB\nCD\ncba\nzyx\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("flushes a buffered prefix before a live simple-command boundary", async () => {
    expect(await executeObserved("echo before && eval 'echo after'")).toEqual({
      observedStdout: "before\nafter\n",
      observedStderr: "",
      stdout: "before\nafter\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps a buffered prefix out of a later pipeline stage", async () => {
    expect(
      await executeObserved(
        "f() { echo func; }; echo before && f | tr a-z A-Z",
      ),
    ).toEqual({
      observedStdout: "before\nFUNC\n",
      observedStderr: "",
      stdout: "before\nFUNC\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("applies call-site redirects to a live user-script boundary", async () => {
    expect(
      await executeObserved("/writer > /written; cat /written", {
        "/writer": {
          content: "#!/bin/bash\necho script-output",
          mode: 0o755,
        },
      }),
    ).toEqual({
      observedStdout: "script-output\n",
      observedStderr: "",
      stdout: "script-output\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
