import { describe, expect, it } from "vitest";
import { encode } from "../utils/bytes.js";
import { type JobSignal, ProcessTable } from "./process-table.js";

function waitForAbort(signal: AbortSignal): Promise<number> {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) {
      reject(new Error(String(signal.reason)));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(new Error(String(signal.reason))),
      { once: true },
    );
  });
}

describe("ProcessTable", () => {
  it("allocates monotonic PIDs and returns immutable job snapshots", async () => {
    let finishFirst: (exitCode: number) => void = () => undefined;
    const firstResult = new Promise<number>((resolve) => {
      finishFirst = resolve;
    });
    const table = new ProcessTable();
    const first = table.start("first", () => firstResult);
    const second = table.start("second", async () => 7);

    expect(first).toBe(1000);
    expect(second).toBe(1001);
    const firstInfo = table.get(first);
    expect(firstInfo).toEqual({
      pid: 1000,
      command: "first",
      startedAt: firstInfo?.startedAt,
      state: "running",
    });
    expect(table.list()).toEqual([
      firstInfo,
      {
        pid: 1001,
        command: "second",
        startedAt: table.get(second)?.startedAt,
        state: "running",
      },
    ]);

    if (firstInfo) {
      firstInfo.command = "mutated snapshot";
    }
    expect(table.get(first)?.command).toBe("first");

    finishFirst(3);
    expect(await table.wait(first)).toBe(3);
    expect(await table.wait(second)).toBe(7);
    expect(table.get(first)).toEqual({
      pid: 1000,
      command: "first",
      startedAt: table.get(first)?.startedAt,
      state: "done",
      exitCode: 3,
    });
  });

  it("maps kill signals to shell exit statuses", async () => {
    const cases: Array<[JobSignal, number]> = [
      ["SIGTERM", 143],
      ["SIGINT", 130],
      ["SIGKILL", 137],
    ];

    for (const [signal, expected] of cases) {
      const table = new ProcessTable();
      const pid = table.start(signal, (_pid, jobSignal) =>
        waitForAbort(jobSignal),
      );

      expect(table.kill(pid, signal)).toBe(true);
      expect(table.kill(pid + 999, signal)).toBe(false);
      expect(await table.wait(pid)).toBe(expected);
      expect(table.kill(pid, signal)).toBe(false);
      expect(table.get(pid)?.exitCode).toBe(expected);
    }
  });

  it("waits for all jobs and reports exit callbacks exactly once", async () => {
    const exits: Array<[number, number]> = [];
    const table = new ProcessTable({
      onJobExit: (pid, exitCode) => exits.push([pid, exitCode]),
    });
    const first = table.start("one", async () => 4);
    const second = table.start("two", async () => 9);

    expect(await table.wait()).toBe(0);
    expect(await table.wait(first)).toBe(4);
    expect(await table.wait(second)).toBe(9);
    expect(exits).toEqual([
      [1000, 4],
      [1001, 9],
    ]);
    expect(await table.wait(999999)).toBe(127);
  });

  it("aborts all running jobs without changing completed jobs", async () => {
    const table = new ProcessTable();
    const done = table.start("done", async () => 5);
    expect(await table.wait(done)).toBe(5);
    const first = table.start("first", (_pid, signal) => waitForAbort(signal));
    const second = table.start("second", (_pid, signal) =>
      waitForAbort(signal),
    );

    table.abortAll("SIGINT");

    expect(await table.wait(first)).toBe(130);
    expect(await table.wait(second)).toBe(130);
    expect(await table.wait(done)).toBe(5);
    expect(table.runningCount).toBe(0);
  });

  it("disposes by killing and clearing every running job", async () => {
    const table = new ProcessTable();
    const pid = table.start("forever", (_pid, signal) => waitForAbort(signal));
    const settled = table.wait(pid);

    table.dispose();

    expect(await settled).toBe(137);
    expect(table.list()).toEqual([]);
    expect(table.get(pid)).toBeUndefined();
    expect(() => table.start("late", async () => 0)).toThrow(
      "Cannot start a job on a disposed ProcessTable",
    );
  });

  it("observes output without retaining any bytes", async () => {
    let observedBytes = 0;
    const table = new ProcessTable({
      onJobOutput: (_pid, _fd, chunk) => {
        observedBytes += chunk.length;
      },
    });
    const pid = table.start("producer", async () => 0);
    const chunk = encode("x".repeat(64 * 1024));

    for (let i = 0; i < 32; i++) {
      table.observeOutput(pid, 1, chunk);
    }

    expect(await table.wait(pid)).toBe(0);
    expect(observedBytes).toBe(2 * 1024 * 1024);
    expect(table.retainedOutputBytes(pid)).toBe(0);
  });
});
