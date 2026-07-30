import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";

interface ExpectedExecution {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function expectWithAndWithoutSinks(
  script: string,
  expected: ExpectedExecution,
  createBash: () => Bash = () => new Bash(),
): Promise<void> {
  expect(await toText(await createBash().exec(script))).toEqual(
    expect.objectContaining(expected),
  );

  let observedStdout = "";
  let observedStderr = "";
  const result = await toText(
    await createBash().exec(script, {
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
    observedStdout: expected.stdout,
    observedStderr: expected.stderr,
    ...expected,
  });
}

describe("sequencing output channels", () => {
  it("publishes loop output before an abort unwinds the loop", async () => {
    const controller = new AbortController();
    let observedStdout = "";
    let sawTwoLinesBeforeAbort = false;
    let marks = 0;
    const bash = new Bash({
      executionLimits: { maxLoopIterations: 100_000 },
      customCommands: [
        defineCommand("mark", async () => {
          marks++;
          if (marks === 2) {
            sawTwoLinesBeforeAbort = observedStdout === "x\nx\n";
            controller.abort();
          }
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });

    const result = await toText(
      await bash.exec("while true; do echo x; mark; sleep 0.05; done", {
        signal: controller.signal,
        stdoutSink: {
          write(chunk) {
            observedStdout += decode(chunk);
          },
        },
      }),
    );

    expect({
      sawTwoLinesBeforeAbort,
      observedStdout,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      sawTwoLinesBeforeAbort: true,
      observedStdout: "x\nx\n",
      stdout: "x\nx\n",
      stderr: "",
      exitCode: 143,
    });
  });

  it("delivers nested break and continue output exactly once", async () => {
    await expectWithAndWithoutSinks(
      `
        for outer in 1 2; do
          echo "outer:$outer:before"
          for inner in 1 2 3; do
            echo "inner:$outer:$inner"
            if [ "$inner" = 1 ]; then continue; fi
            if [ "$outer" = 2 ]; then break 2; fi
            echo "inner:$outer:$inner:after"
          done
          echo "outer:$outer:after"
        done
        echo done
      `,
      {
        stdout:
          "outer:1:before\n" +
          "inner:1:1\n" +
          "inner:1:2\n" +
          "inner:1:2:after\n" +
          "inner:1:3\n" +
          "inner:1:3:after\n" +
          "outer:1:after\n" +
          "outer:2:before\n" +
          "inner:2:1\n" +
          "inner:2:2\n" +
          "done\n",
        stderr: "",
        exitCode: 0,
      },
    );
  });

  it("delivers errexit and exit output exactly once", async () => {
    await expectWithAndWithoutSinks(
      "set -e; for i in 1 2; do echo $i; echo e$i >&2; false; done",
      { stdout: "1\n", stderr: "e1\n", exitCode: 1 },
    );
    await expectWithAndWithoutSinks(
      'for i in 1 2; do echo $i; echo e$i >&2; if [ "$i" = 1 ]; then exit 7; fi; done',
      { stdout: "1\n", stderr: "e1\n", exitCode: 7 },
    );
  });

  it("delivers multi-level continue output exactly once", async () => {
    await expectWithAndWithoutSinks(
      `
        for outer in 1 2; do
          echo "outer:$outer"
          for inner in 1 2; do
            echo "inner:$outer:$inner"
            continue 2
          done
          echo never
        done
        echo done
      `,
      {
        stdout: "outer:1\ninner:1:1\nouter:2\ninner:2:1\ndone\n",
        stderr: "",
        exitCode: 0,
      },
    );
  });

  it("delivers condition, if, and case output exactly once", async () => {
    await expectWithAndWithoutSinks("while echo cond; false; do :; done", {
      stdout: "cond\n",
      stderr: "",
      exitCode: 0,
    });
    await expectWithAndWithoutSinks(
      "if echo first; false; then echo no; elif echo second; true; then echo yes; fi",
      { stdout: "first\nsecond\nyes\n", stderr: "", exitCode: 0 },
    );
    await expectWithAndWithoutSinks(
      "case foo in bar) echo no;; f*) echo match; echo case-error >&2;; esac",
      { stdout: "match\n", stderr: "case-error\n", exitCode: 0 },
    );
  });

  it("flushes earlier and-list output before a converted compound", async () => {
    await expectWithAndWithoutSinks(
      "printf 'before\\n' && echo preerr >&2 && for i in 1 2; do echo $i; echo e$i >&2; done",
      {
        stdout: "before\n1\n2\n",
        stderr: "preerr\ne1\ne2\n",
        exitCode: 0,
      },
    );
    await expectWithAndWithoutSinks(
      "printf 'before\\n' && echo preerr >&2 && for i in 1; do echo $i; exit 7; done",
      {
        stdout: "before\n1\n",
        stderr: "preerr\n",
        exitCode: 7,
      },
    );
  });

  it("combines root collector and carried error bytes for fatal paths", async () => {
    await expectWithAndWithoutSinks(
      "set -o posix; echo before; shift 1; echo after",
      {
        stdout: "before\n",
        stderr: "bash: shift: shift count out of range\n",
        exitCode: 1,
      },
    );
    await expectWithAndWithoutSinks("echo before; echo $((1/0)); echo after", {
      stdout: "before\nafter\n",
      stderr: "bash: division by 0\n",
      exitCode: 0,
    });
    await expectWithAndWithoutSinks(
      "echo before; while true; do echo x; done",
      {
        stdout: "before\nx\nx\n",
        stderr:
          "bash: while loop: too many iterations (2), increase executionLimits.maxLoopIterations\n",
        exitCode: 126,
      },
      () =>
        new Bash({
          executionLimits: { maxLoopIterations: 2 },
        }),
    );
  });
});
