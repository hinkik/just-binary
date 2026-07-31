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

  // A non-interactive bash reaps a completed child as it notices it, so the job
  // is gone from `jobs` before any later command can see it. Verified against
  // real bash 3.2: `false & sleep 0.05; jobs` prints nothing and exits 0, and
  // `jobs %1` for the same job reports "no such job" with status 1.
  it("never lists a completed job but keeps its wait status", async () => {
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const table = new ProcessTable({
      onJobExit: () => markExited(),
    });
    const pid = table.start("false &", async () => 1);
    await exited;

    expect(table.listJobs()).toEqual([]);
    expect(table.list()).toEqual([]);
    expect(table.get(pid)).toBeUndefined();
    // The status outlives the record, so `wait <pid>` still answers like bash.
    expect(table.canWait(pid)).toBe(true);
    expect(await table.wait(pid)).toBe(1);
    expect(await table.wait(pid)).toBe(1);

    expect(await table.wait()).toBe(0);
    expect(await table.wait(pid)).toBe(127);
  });

  // Reaping at settle would otherwise lose bash's `kill %1; wait %1` idiom,
  // which works because bash has not yet processed the child's death.
  it("still resolves a job spec for a job it has just reaped", async () => {
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const table = new ProcessTable({ onJobExit: () => markExited() });
    const pid = table.start("sleep 9 &", async () => 143);
    await exited;

    expect(table.resolveJobSpec("%1")).toBe(pid);
    expect(await table.wait(pid)).toBe(143);
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

  // The retention bound must sit far above realistic use: evicting a status
  // makes `wait` report 127 where bash reports the real code. Real bash keeps
  // this one — `sleep 0.01 & f=$!; ...70 more jobs...; wait $f` exits 0.
  it("keeps every wait status for a realistic number of jobs", async () => {
    const table = new ProcessTable();
    const first = table.start("first", async () => 3);
    expect(await table.wait(first)).toBe(3);

    for (let index = 0; index < 200; index++) {
      const pid = table.start(`job ${index}`, async () => 0);
      expect(await table.wait(pid)).toBe(0);
    }

    expect(table.canWait(first)).toBe(true);
    expect(await table.wait(first)).toBe(3);
  });

  it("evicts least-recently-remembered statuses past the retention bound", async () => {
    const table = new ProcessTable();
    const pids: number[] = [];
    // One past the 4096-status cap, so exactly the oldest is dropped.
    for (let index = 0; index < 4097; index++) {
      const pid = table.start(`job ${index}`, async () => 0);
      pids.push(pid);
      expect(await table.wait(pid)).toBe(0);
    }

    expect(table.canWait(pids[0])).toBe(false);
    expect(await table.wait(pids[0])).toBe(127);
    expect(table.canWait(pids[4096])).toBe(true);
    expect(await table.wait(pids[4096])).toBe(0);
  });
});
