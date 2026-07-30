import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProcessTable } from "./process-table.js";

describe("ProcessTable async observers", () => {
  const unhandledRejections: unknown[] = [];
  const trackUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason);
  };

  beforeEach(() => {
    unhandledRejections.length = 0;
    process.on("unhandledRejection", trackUnhandledRejection);
  });

  afterEach(() => {
    process.off("unhandledRejection", trackUnhandledRejection);
  });

  it("isolates async onJobExit failures from job settlement", async () => {
    const exitCalls: Array<[number, number]> = [];
    const table = new ProcessTable({
      onJobExit: async (pid, exitCode) => {
        exitCalls.push([pid, exitCode]);
        throw new Error("exit observer failed");
      },
    });
    const pid = table.start("exit observer", async () => 23);

    expect(await table.wait(pid)).toBe(23);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unhandledRejections).toEqual([]);
    expect(exitCalls).toEqual([[1000, 23]]);
    expect(table.get(pid)).toBeUndefined();
  });

  it("isolates async onJobOutput failures from job execution", async () => {
    const outputCalls: Array<[number, number, number[]]> = [];
    const table = new ProcessTable({
      onJobOutput: async (pid, fd, chunk) => {
        outputCalls.push([pid, fd, [...chunk]]);
        throw new Error("output observer failed");
      },
    });
    const pid = table.start("output observer", async (jobPid) => {
      table.observeOutput(jobPid, 1, new Uint8Array([111, 107]));
      return 17;
    });

    expect(await table.wait(pid)).toBe(17);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(unhandledRejections).toEqual([]);
    expect(outputCalls).toEqual([[1000, 1, [111, 107]]]);
    expect(table.get(pid)).toBeUndefined();
  });
});
