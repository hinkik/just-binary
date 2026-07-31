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

describe("wait exec lineage", () => {
  it("does not make bare wait block on a job from an unrelated top-level exec", async () => {
    const processes = new ProcessTable();
    let releaseSleep = (): void => undefined;
    let markSleepStarted = (): void => undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const sleep = (): Promise<void> =>
      new Promise((resolve) => {
        releaseSleep = resolve;
        markSleepStarted();
      });
    const firstShell = new Bash({ processes, sleep });
    const secondShell = new Bash({ processes, sleep });

    expectResult(
      await toText(await firstShell.exec("sleep 9 & echo started")),
      {
        stdout: "started\n",
        stderr: "",
        exitCode: 0,
      },
    );
    await sleepStarted;

    const secondExec = secondShell
      .exec("echo quick; wait; echo after")
      .then(toText);
    const settled = await Promise.race([
      secondExec.then(() => "settled"),
      new Promise<"timeout">((resolve) =>
        setTimeout(() => resolve("timeout"), 50),
      ),
    ]);

    try {
      expect(settled).toBe("settled");
      expectResult(await secondExec, {
        stdout: "quick\nafter\n",
        stderr: "",
        exitCode: 0,
      });
      expect(processes.runningCount).toBe(1);
    } finally {
      releaseSleep();
      await processes.wait();
    }
  });

  it("still permits an explicit PID to target a job from another exec", async () => {
    const processes = new ProcessTable();
    let releaseSleep = (): void => undefined;
    let markSleepStarted = (): void => undefined;
    const sleepStarted = new Promise<void>((resolve) => {
      markSleepStarted = resolve;
    });
    const sleep = (): Promise<void> =>
      new Promise((resolve) => {
        releaseSleep = resolve;
        markSleepStarted();
      });
    const firstShell = new Bash({ processes, sleep });
    const secondShell = new Bash({ processes, sleep });

    await toText(await firstShell.exec("sleep 9 &"));
    await sleepStarted;
    const waiting = secondShell.exec("wait 1000").then(toText);
    releaseSleep();

    expectResult(await waiting, {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("inherits the root lineage through functions, groups, subshells, and nested shells", async () => {
    const processes = new ProcessTable();
    const releases: Array<() => void> = [];
    let markAllStarted = (): void => undefined;
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    const sleep = (): Promise<void> =>
      new Promise((resolve) => {
        releases.push(resolve);
        if (releases.length === 4) {
          markAllStarted();
        }
      });
    const bash = new Bash({ processes, sleep });
    const execution = bash
      .exec(
        "f() { sleep 9 & }; f; { sleep 9 & }; " +
          "(sleep 9 &); bash -c 'sleep 9 &'; " +
          "echo before; wait; echo after",
      )
      .then(toText);

    await allStarted;
    const settledBeforeRelease = await Promise.race([
      execution.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 30)),
    ]);
    expect(settledBeforeRelease).toBe(false);

    for (const release of releases) {
      release();
    }
    expectResult(await execution, {
      stdout: "before\nafter\n",
      stderr: "",
      exitCode: 0,
    });
    expect(processes.list()).toEqual([]);
  });
});
