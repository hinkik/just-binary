import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ProcessTable } from "../process/process-table.js";
import { type TextResult, toText } from "../test-utils.js";

describe("Bash background-job limits", () => {
  it("returns 126 for owned and injected process tables", async () => {
    const results: TextResult[] = [];

    for (const processes of [undefined, new ProcessTable()]) {
      const bash = new Bash({
        ...(processes ? { processes } : {}),
        executionLimits: { maxConcurrentJobs: 1 },
      });
      results.push(await toText(await bash.exec("{ true & } &")));
      await bash.processes.wait();
    }

    expect(
      results.map(({ stdout, stderr, exitCode }) => ({
        stdout,
        stderr,
        exitCode,
      })),
    ).toEqual([
      {
        stdout: "",
        stderr: "bash: maximum concurrent jobs (1) exceeded\n",
        exitCode: 126,
      },
      {
        stdout: "",
        stderr: "bash: maximum concurrent jobs (1) exceeded\n",
        exitCode: 126,
      },
    ]);
  });

  it("does not attribute a shared table's limit failure to another shell", async () => {
    const processes = new ProcessTable();
    const first = new Bash({
      processes,
      executionLimits: { maxConcurrentJobs: 1 },
    });
    const second = new Bash({
      processes,
      executionLimits: { maxConcurrentJobs: 1 },
    });

    const results = await Promise.all([
      first.exec("sleep 5 &").then(toText),
      second.exec("sleep 5 &").then(toText),
    ]);

    expect(
      results.map(({ stdout, stderr, exitCode }) => ({
        stdout,
        stderr,
        exitCode,
      })),
    ).toEqual([
      { stdout: "", stderr: "", exitCode: 0 },
      {
        stdout: "",
        stderr: "bash: maximum concurrent jobs (1) exceeded\n",
        exitCode: 126,
      },
    ]);
    expect(processes.runningCount).toBe(1);

    processes.abortAll();
    expect(await processes.wait()).toBe(0);
  });
});
