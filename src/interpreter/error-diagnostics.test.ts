import { describe, expect, it } from "vitest";
import { Bash, type ExecOptions } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";
import { emptyStream } from "../utils/stream.js";

interface ExpectedExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface DiagnosticCase extends ExpectedExecution {
  name: string;
  script: string;
  setup: () => { bash: Bash; options?: ExecOptions };
}

function defaultSetup(): { bash: Bash } {
  return { bash: new Bash() };
}

async function expectWithAndWithoutSinks(
  testCase: DiagnosticCase,
): Promise<void> {
  const plainSetup = testCase.setup();
  const plain = await toText(
    await plainSetup.bash.exec(testCase.script, plainSetup.options),
  );
  expect({
    stdout: plain.stdout,
    stderr: plain.stderr,
    exitCode: plain.exitCode,
  }).toEqual({
    stdout: testCase.stdout,
    stderr: testCase.stderr,
    exitCode: testCase.exitCode,
  });

  let observedStdout = "";
  let observedStderr = "";
  const observedSetup = testCase.setup();
  const observed = await toText(
    await observedSetup.bash.exec(testCase.script, {
      ...observedSetup.options,
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
    stdout: observed.stdout,
    stderr: observed.stderr,
    exitCode: observed.exitCode,
  }).toEqual({
    observedStdout: testCase.stdout,
    observedStderr: testCase.stderr,
    stdout: testCase.stdout,
    stderr: testCase.stderr,
    exitCode: testCase.exitCode,
  });
}

const cases: DiagnosticCase[] = [
  {
    name: "nounset",
    script: "set -u; echo $UNSET",
    setup: defaultSetup,
    stdout: "",
    stderr: "bash: UNSET: unbound variable\n",
    exitCode: 1,
  },
  {
    name: "command count",
    script: "echo before; echo kept; echo never",
    setup: () => ({
      bash: new Bash({ executionLimits: { maxCommandCount: 3 } }),
    }),
    stdout: "before\nkept\n",
    stderr:
      "bash: too many commands executed (>3), increase executionLimits.maxCommandCount\n",
    exitCode: 126,
  },
  {
    name: "for-loop iterations",
    script: "echo before; for i in 1 2 3; do echo for:$i; done",
    setup: () => ({
      bash: new Bash({ executionLimits: { maxLoopIterations: 2 } }),
    }),
    stdout: "before\nfor:1\nfor:2\n",
    stderr:
      "bash: for loop: too many iterations (2), increase executionLimits.maxLoopIterations\n",
    exitCode: 126,
  },
  {
    name: "C-style for-loop iterations",
    script: "echo before; for ((i=0; i<3; i++)); do echo cfor:$i; done",
    setup: () => ({
      bash: new Bash({ executionLimits: { maxLoopIterations: 2 } }),
    }),
    stdout: "before\ncfor:0\ncfor:1\n",
    stderr:
      "bash: for loop: too many iterations (2), increase executionLimits.maxLoopIterations\n",
    exitCode: 126,
  },
  {
    name: "while-loop iterations",
    script: "echo before; while true; do echo while; done",
    setup: () => ({
      bash: new Bash({ executionLimits: { maxLoopIterations: 2 } }),
    }),
    stdout: "before\nwhile\nwhile\n",
    stderr:
      "bash: while loop: too many iterations (2), increase executionLimits.maxLoopIterations\n",
    exitCode: 126,
  },
  {
    name: "until-loop iterations",
    script: "echo before; until false; do echo until; done",
    setup: () => ({
      bash: new Bash({ executionLimits: { maxLoopIterations: 2 } }),
    }),
    stdout: "before\nuntil\nuntil\n",
    stderr:
      "bash: until loop: too many iterations (2), increase executionLimits.maxLoopIterations\n",
    exitCode: 126,
  },
  {
    name: "recursion depth",
    script: "f() { echo depth; f; }; f",
    setup: () => ({
      bash: new Bash({ executionLimits: { maxCallDepth: 2 } }),
    }),
    stdout: "depth\ndepth\n",
    stderr:
      "bash: f: maximum recursion depth (2) exceeded, increase executionLimits.maxCallDepth\n",
    exitCode: 126,
  },
  {
    name: "string length",
    script: "echo before; value=12345",
    setup: () => ({
      bash: new Bash({ executionLimits: { maxStringLength: 4 } }),
    }),
    stdout: "before\n",
    stderr: "bash: word expansion: string length limit exceeded (4 bytes)\n",
    exitCode: 126,
  },
  {
    name: "glob operations",
    script: "echo before; echo *",
    setup: () => ({
      bash: new Bash({
        cwd: "/work",
        files: { "/work/a": "", "/work/b": "" },
        executionLimits: { maxGlobOperations: 1 },
      }),
    }),
    stdout: "before\n",
    stderr: "bash: Glob operation limit exceeded (1)\n",
    exitCode: 126,
  },
  {
    name: "substitution depth",
    script: "echo before; echo $(echo $(echo $(echo deep)))",
    setup: () => ({
      bash: new Bash({ executionLimits: { maxSubstitutionDepth: 2 } }),
    }),
    stdout: "before\n",
    stderr: "bash: Command substitution nesting limit exceeded (2)\n",
    exitCode: 126,
  },
  {
    name: "exit from a loop",
    script: "for i in 1 2; do echo loop:$i; exit 5; done",
    setup: defaultSetup,
    stdout: "loop:1\n",
    stderr: "",
    exitCode: 5,
  },
  {
    name: "exit from a function",
    script: "f() { echo function; exit 5; }; f; echo never",
    setup: defaultSetup,
    stdout: "function\n",
    stderr: "",
    exitCode: 5,
  },
  {
    name: "exit from a subshell",
    script: "echo before; (echo subshell; exit 5)",
    setup: defaultSetup,
    stdout: "before\nsubshell\n",
    stderr: "",
    exitCode: 5,
  },
  {
    name: "errexit",
    script: "set -e; echo a; false; echo never",
    setup: defaultSetup,
    stdout: "a\n",
    stderr: "",
    exitCode: 1,
  },
  {
    name: "arithmetic error",
    script: "echo before; echo $((1/0))",
    setup: defaultSetup,
    stdout: "before\n",
    stderr: "bash: division by 0\n",
    exitCode: 1,
  },
  {
    name: "parse-time arithmetic error",
    script: "echo $((1.2))",
    setup: defaultSetup,
    stdout: "",
    stderr: "bash: 1.2...: syntax error: invalid arithmetic operator\n",
    exitCode: 1,
  },
  {
    name: "bad substitution",
    script: "echo before; echo ${foo[]}",
    setup: defaultSetup,
    stdout: "before\n",
    stderr: "bash: ${foo[]}: bad substitution\n",
    exitCode: 1,
  },
  {
    name: "failglob",
    script: "echo before; shopt -s failglob; echo *.missing",
    setup: () => ({
      bash: new Bash({ cwd: "/work", files: { "/work/present": "" } }),
    }),
    stdout: "before\n",
    stderr: "bash: no match: *.missing\n",
    exitCode: 1,
  },
  {
    name: "brace expansion error",
    script: "echo before; echo {z..A}",
    setup: defaultSetup,
    stdout: "before\n",
    stderr: "bash: {z..A}: invalid sequence\n",
    exitCode: 1,
  },
  {
    name: "abort",
    script: "echo before; stop; echo never",
    setup: () => {
      const controller = new AbortController();
      const stop = defineCommand("stop", async () => {
        controller.abort("SIGTERM");
        return {
          stdout: emptyStream(),
          stderr: emptyStream(),
          exitCode: 0,
        };
      });
      return {
        bash: new Bash({ customCommands: [stop] }),
        options: { signal: controller.signal },
      };
    },
    stdout: "before\n",
    stderr: "",
    exitCode: 143,
  },
];

describe("control-flow error diagnostics", () => {
  it.each(cases)(
    "delivers $name bytes exactly once with and without sinks",
    expectWithAndWithoutSinks,
  );
});
