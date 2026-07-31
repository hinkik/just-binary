import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";

interface ControlFlowCase {
  name: string;
  script: string;
  stdout: string;
  stderr: string;
  exitCode: number;
}

const cases: ControlFlowCase[] = [
  {
    name: "break",
    script:
      "for i in 1 2; do echo before:$i; break; echo never; done; echo after",
    stdout: "before:1\nafter\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "continue",
    script:
      "for i in 1 2; do echo before:$i; continue; echo never; done; echo after",
    stdout: "before:1\nbefore:2\nafter\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "return",
    script: "f() { echo before; return 7; echo never; }; f",
    stdout: "before\n",
    stderr: "",
    exitCode: 7,
  },
  {
    name: "subshell loop exit",
    script:
      "for i in 1; do (echo subshell; break; echo never); echo outer; done",
    stdout: "subshell\nouter\n",
    stderr: "",
    exitCode: 0,
  },
  {
    name: "POSIX fatal error",
    script: "set -o posix; set -- one; shift 2; echo never",
    stdout: "",
    stderr: "bash: shift: shift count out of range\n",
    exitCode: 1,
  },
];

describe("streamless control-flow delivery", () => {
  it.each(
    cases,
  )("delivers $name bytes identically with and without host sinks", async (testCase) => {
    const plain = await toText(await new Bash().exec(testCase.script));
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
    const observed = await toText(
      await new Bash().exec(testCase.script, {
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
  });
});
