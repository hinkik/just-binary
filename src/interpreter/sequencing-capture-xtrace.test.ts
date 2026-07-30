import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";

async function executeObserved(script: string) {
  let observedStdout = "";
  let observedStderr = "";
  const result = await toText(
    await new Bash().exec(script, {
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

describe("sequencing captures and tracing", () => {
  it("captures loop stdout while routing loop stderr live", async () => {
    const result = await executeObserved(
      'out=$(for i in 1 2; do echo $i; echo e$i >&2; done); echo "got:$out"',
    );

    expect(result).toEqual({
      observedStdout: "got:1\n2\n",
      observedStderr: "e1\ne2\n",
      stdout: "got:1\n2\n",
      stderr: "e1\ne2\n",
      exitCode: 0,
    });
  });

  it("does not leak an oversized captured value to root stdout", async () => {
    let observedStdout = "";
    const result = await toText(
      await new Bash({
        executionLimits: { maxStringLength: 2 },
      }).exec("out=$(echo abc); echo after", {
        stdoutSink: {
          write(chunk) {
            observedStdout += decode(chunk);
          },
        },
      }),
    );

    expect({
      observedStdout,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observedStdout: "",
      stdout: "",
      stderr: "bash: word expansion: string length limit exceeded (2 bytes)\n",
      exitCode: 126,
    });
  });

  it("preserves exact xtrace ordering across for iterations", async () => {
    const result = await executeObserved(
      "set -x; for i in 1 2; do echo $i; done",
    );

    expect(result).toEqual({
      observedStdout: "1\n2\n",
      observedStderr: "+ for i in 1 2\n+ echo 1\n+ for i in 1 2\n+ echo 2\n",
      stdout: "1\n2\n",
      stderr: "+ for i in 1 2\n+ echo 1\n+ for i in 1 2\n+ echo 2\n",
      exitCode: 0,
    });
  });

  it("preserves exact verbose ordering around a for loop", async () => {
    const result = await executeObserved(
      "set -v\nfor i in 1 2; do echo $i; done",
    );

    expect(result).toEqual({
      observedStdout: "1\n2\n",
      observedStderr:
        "for i in 1 2; do echo $i; done\n" + "echo $i\n" + "echo $i\n",
      stdout: "1\n2\n",
      stderr: "for i in 1 2; do echo $i; done\n" + "echo $i\n" + "echo $i\n",
      exitCode: 0,
    });
  });

  it("preserves output through deeply nested converted constructs", async () => {
    const result = await executeObserved(`
      for outer in A B; do
        out=$(case "$outer" in
          A|B) if true; then
            for inner in 1 2; do
              echo "$outer$inner"
            done
          fi;;
        esac)
        printf '<%s>\\n' "$out"
      done
    `);

    expect(result).toEqual({
      observedStdout: "<A1\nA2>\n<B1\nB2>\n",
      observedStderr: "",
      stdout: "<A1\nA2>\n<B1\nB2>\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
