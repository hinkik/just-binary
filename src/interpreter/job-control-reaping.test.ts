import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { type TextResult, toText } from "../test-utils.js";

function expectResult(
  result: TextResult,
  expected: { stdout: string; stderr: string; exitCode: number },
): void {
  expect({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }).toEqual(expected);
}

describe("Bash completed-job reaping", () => {
  it("does not list jobs after wait-all and keeps later listings empty", async () => {
    const result = await toText(
      await new Bash().exec("sleep 0.05 & wait; jobs; jobs"),
    );

    expectResult(result, {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("restarts job numbering after wait-all drains the table", async () => {
    const result = await toText(
      await new Bash().exec("sleep 0.01 & wait; sleep 5 & jobs; kill %1"),
    );

    expectResult(result, {
      stdout: "[1]+  Running                 sleep 5 &\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("waits with the right status after the last job has finished", async () => {
    const result = await toText(
      await new Bash().exec(
        'false & pid=$!; sleep 0.01; wait "$pid"; printf "status:%s\\n" "$?"',
      ),
    );

    expectResult(result, {
      stdout: "status:1\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("treats a PID discarded by wait-all as an unknown child", async () => {
    const result = await toText(
      await new Bash().exec(
        'false & pid=$!; wait; wait "$pid"; printf "status:%s\\n" "$?"',
      ),
    );

    expectResult(result, {
      stdout: "status:127\n",
      stderr: "bash: wait: pid 1000 is not a child of this shell\n",
      exitCode: 0,
    });
  });
});
