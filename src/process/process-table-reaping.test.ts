import { describe, expect, it } from "vitest";
import { ProcessTable } from "./process-table.js";

describe("ProcessTable reaping", () => {
  it("reaps 200 completed jobs and recycles job numbers after wait-all", async () => {
    const table = new ProcessTable();
    for (let index = 0; index < 200; index++) {
      table.start(`job ${index}`, async () => 0);
    }

    expect(await table.wait()).toBe(0);
    expect(table.list()).toEqual([]);
    expect(table.runningCount).toBe(0);

    const nextPid = table.start("next", async () => 0);
    expect(table.getJobNumber(nextPid)).toBe(1);
    expect(await table.wait()).toBe(0);
  });

  it("reports a completed job once while retaining its bounded wait status", async () => {
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const table = new ProcessTable({
      onJobExit: () => markExited(),
    });
    const pid = table.start("false &", async () => 1);
    await exited;
    const startedAt = table.get(pid)?.startedAt;

    expect(table.listJobs()).toEqual([
      {
        pid,
        command: "false &",
        startedAt,
        state: "done",
        exitCode: 1,
        jobNumber: 1,
        marker: "+",
      },
    ]);
    expect(table.listJobs()).toEqual([]);
    expect(await table.wait(pid)).toBe(1);
    expect(await table.wait(pid)).toBe(1);

    expect(await table.wait()).toBe(0);
    expect(await table.wait(pid)).toBe(127);
  });

  it("does not clear statuses cached concurrently with wait-all", async () => {
    let finishFirst: () => void = () => undefined;
    const firstResult = new Promise<number>((resolve) => {
      finishFirst = () => resolve(0);
    });
    const table = new ProcessTable();
    table.start("first", () => firstResult);
    const waitingForFirst = table.wait();
    const second = table.start("second", async () => 7);

    expect(await table.wait(second)).toBe(7);
    finishFirst();
    expect(await waitingForFirst).toBe(0);

    expect(await table.wait(second)).toBe(7);
  });

  it("bounds statuses retained by targeted waits", async () => {
    const table = new ProcessTable();
    const pids: number[] = [];
    for (let index = 0; index < 65; index++) {
      const pid = table.start(`job ${index}`, async () => index);
      pids.push(pid);
      expect(await table.wait(pid)).toBe(index);
    }

    expect(table.canWait(pids[0])).toBe(false);
    expect(await table.wait(pids[0])).toBe(127);
    expect(table.canWait(pids[64])).toBe(true);
    expect(await table.wait(pids[64])).toBe(64);
  });
});
