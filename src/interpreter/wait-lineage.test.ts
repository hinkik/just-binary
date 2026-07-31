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

  // Bash's `wait` waits for the shell's OWN children. Ownership therefore
  // follows the fork boundary: functions, groups, `eval` and `source` run in the
  // current shell and keep its lineage, while a subshell, a nested shell and a
  // background job are forks whose jobs belong to them. Verified against real
  // bash 3.2 — `f(){ sleep 3 & }; f; wait` and `{ sleep 3 & }; wait` both take
  // 3s, while `( sleep 3 & ); wait`, `bash -c 'sleep 3 &'; wait` and
  // `{ sleep 3 & } & wait` all return immediately.
  it("keeps the caller's lineage through functions, groups, and eval", async () => {
    const processes = new ProcessTable();
    const releases: Array<() => void> = [];
    let markAllStarted = (): void => undefined;
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    const sleep = (): Promise<void> =>
      new Promise((resolve) => {
        releases.push(resolve);
        if (releases.length === 3) {
          markAllStarted();
        }
      });
    const bash = new Bash({ processes, sleep });
    const execution = bash
      .exec(
        "f() { sleep 9 & }; f; { sleep 9 & }; eval 'sleep 9 &'; " +
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

  it("gives subshells, nested shells, and background jobs their own lineage", async () => {
    const processes = new ProcessTable();
    const releases: Array<() => void> = [];
    let markAllStarted = (): void => undefined;
    const allStarted = new Promise<void>((resolve) => {
      markAllStarted = resolve;
    });
    const sleep = (): Promise<void> =>
      new Promise((resolve) => {
        releases.push(resolve);
        if (releases.length === 2) {
          markAllStarted();
        }
      });
    const bash = new Bash({ processes, sleep });

    // Every job here belongs to a forked shell, so `wait` must return without
    // any of them being released.
    const execution = bash
      .exec("(sleep 9 &); bash -c 'sleep 9 &'; echo before; wait; echo after")
      .then(toText);

    await allStarted;
    expectResult(await execution, {
      stdout: "before\nafter\n",
      stderr: "",
      exitCode: 0,
    });
    expect(releases).toHaveLength(2);

    for (const release of releases) {
      release();
    }
  });

  it("does not let a background job's own wait block on itself", async () => {
    // The job's record carries the parent's lineage so the parent can wait for
    // it, but the job's shell gets a fresh lineage — otherwise its `wait` would
    // await its own record and deadlock. Real bash: `(wait) & wait` returns 0.
    const processes = new ProcessTable();
    const bash = new Bash({ processes });

    const settled = await Promise.race([
      bash.exec("(wait) & wait; echo done").then(toText),
      new Promise<"DEADLOCK">((resolve) =>
        setTimeout(() => resolve("DEADLOCK"), 5000),
      ),
    ]);
    expect(settled).not.toBe("DEADLOCK");
    expectResult(settled as TextResult, {
      stdout: "done\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
