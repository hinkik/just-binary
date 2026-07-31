import { describe, expect, it } from "vitest";
import { ProcessTable } from "./process-table.js";

describe("ProcessTable disposal", () => {
  it("waits for an aborted runner to finish unwinding", async () => {
    const table = new ProcessTable();
    let cleanupFinished = false;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    table.start(
      "cleanup",
      async (_pid, signal) =>
        new Promise<number>((resolve) => {
          markStarted();
          const finish = () => {
            setTimeout(() => {
              cleanupFinished = true;
              resolve(0);
            }, 25);
          };
          if (signal.aborted) {
            finish();
          } else {
            signal.addEventListener("abort", finish, { once: true });
          }
        }),
    );
    await started;

    const disposal = table.dispose();
    expect(cleanupFinished).toBe(false);
    await disposal;

    expect(cleanupFinished).toBe(true);
    expect(table.list()).toEqual([]);
  });

  it("bounds disposal when a runner delays cancellation", async () => {
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let releaseRunner: () => void = () => undefined;
    const runnerRelease = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let markExited: () => void = () => undefined;
    const exited = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    let cleanupFinished = false;
    const table = new ProcessTable({
      disposeTimeoutMs: 10,
      onJobExit: () => markExited(),
    });
    table.start("delays cancellation", async () => {
      markStarted();
      await runnerRelease;
      cleanupFinished = true;
      return 0;
    });
    await started;
    const startedAt = performance.now();

    await table.dispose();

    expect(performance.now() - startedAt).toBeLessThan(500);
    expect(cleanupFinished).toBe(false);
    expect(() => table.start("late", async () => 0)).toThrow(
      "Cannot start a job on a disposed ProcessTable",
    );

    releaseRunner();
    await exited;
    expect(cleanupFinished).toBe(true);
  });
});
