import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ProcessTable } from "../process/process-table.js";
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

function sleepUntilAborted(
  _milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("Bash job-control builtins", () => {
  it("runs ampersand statements asynchronously and wait forwards their output", async () => {
    const result = await toText(await new Bash().exec("echo hi & wait"));

    expectResult(result, {
      stdout: "hi\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("sets the last-background PID without an interactive announcement", async () => {
    const result = await toText(
      await new Bash().exec('sleep 0 & printf "pid:%s\\n" "$!"; wait'),
    );

    expectResult(result, {
      stdout: "pid:1000\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("lists running jobs in non-interactive Bash format", async () => {
    const processes = new ProcessTable();
    const bash = new Bash({
      processes,
      sleep: sleepUntilAborted,
    });
    const result = await toText(
      await bash.exec("sleep 5 & jobs; kill $!; wait $! 2>/dev/null; true"),
    );

    expectResult(result, {
      stdout: "[1]+  Running                 sleep 5 &\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("supports named and numeric TERM, INT, and KILL signals", async () => {
    const processes = new ProcessTable();
    const bash = new Bash({
      processes,
      sleep: sleepUntilAborted,
    });
    const result = await toText(
      await bash.exec(`
        sleep 9 & p=$!; kill -TERM "$p"; wait "$p"; echo TERM:$?
        sleep 9 & p=$!; kill -15 "$p"; wait "$p"; echo 15:$?
        sleep 9 & p=$!; kill -INT "$p"; wait "$p"; echo INT:$?
        sleep 9 & p=$!; kill -2 "$p"; wait "$p"; echo 2:$?
        sleep 9 & p=$!; kill -KILL "$p"; wait "$p"; echo KILL:$?
        sleep 9 & p=$!; kill -9 "$p"; wait "$p"; echo 9:$?
      `),
    );

    expectResult(result, {
      stdout: "TERM:143\n15:143\nINT:130\n2:130\nKILL:137\n9:137\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("reports exact errors for unknown kill and wait PIDs", async () => {
    const bash = new Bash();
    const killResult = await toText(await bash.exec("kill 999999"));
    const waitResult = await toText(await bash.exec("wait 999999"));

    expectResult(killResult, {
      stdout: "",
      stderr: "bash: kill: (999999) - No such process\n",
      exitCode: 1,
    });
    expectResult(waitResult, {
      stdout: "",
      stderr: "bash: wait: pid 999999 is not a child of this shell\n",
      exitCode: 127,
    });
  });

  it("wait with no jobs succeeds without output", async () => {
    const result = await toText(await new Bash().exec("wait"));

    expectResult(result, {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("supports numeric, current, and previous job specifications", async () => {
    const processes = new ProcessTable();
    const bash = new Bash({
      processes,
      sleep: sleepUntilAborted,
    });
    const result = await toText(
      await bash.exec(`
        sleep 9 &
        sleep 9 &
        kill %-; wait %1; echo previous:$?
        kill %+; wait %2; echo current:$?
      `),
    );

    expectResult(result, {
      stdout: "previous:143\ncurrent:143\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("marks the previous and current jobs in a two-job listing", async () => {
    const processes = new ProcessTable();
    const bash = new Bash({
      processes,
      sleep: sleepUntilAborted,
    });
    const result = await toText(
      await bash.exec(`
        sleep 9 &
        sleep 9 &
        jobs
        kill %1 %2
        wait
      `),
    );

    expectResult(result, {
      stdout:
        "[1]-  Running                 sleep 9 &\n" +
        "[2]+  Running                 sleep 9 &\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
