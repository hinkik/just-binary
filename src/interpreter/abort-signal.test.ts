import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { toText } from "../test-utils.js";

/**
 * A `mark` command that reports execution progress back to the test, so
 * aborts can be triggered by where the script actually is instead of racing
 * a wall-clock timer against interpreter startup (flaky under suite load).
 */
function progressMark(onMark: (count: number) => void) {
  let count = 0;
  return defineCommand("mark", async () => {
    count++;
    onMark(count);
    return { stdout: "", stderr: "", exitCode: 0 };
  });
}

describe("ExecOptions.signal cancellation", () => {
  it("returns immediately when the signal is already aborted", async () => {
    const bash = new Bash();
    const controller = new AbortController();
    controller.abort();

    const result = await toText(
      await bash.exec("echo never", { signal: controller.signal }),
    );
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("cancels a sleeping command and preserves prior output", async () => {
    const controller = new AbortController();
    // Abort shortly after `mark` runs — echo has completed, sleep is next.
    const bash = new Bash({
      customCommands: [
        progressMark(() => setTimeout(() => controller.abort(), 25)),
      ],
    });

    const start = Date.now();
    const result = await toText(
      await bash.exec("echo before; mark; sleep 30; echo after", {
        signal: controller.signal,
      }),
    );
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toBe("before\n");
    expect(result.stderr).toBe("");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("maps abort reason SIGINT to exit code 130", async () => {
    const bash = new Bash();
    const controller = new AbortController();

    const pending = bash.exec("sleep 30", { signal: controller.signal });
    setTimeout(() => controller.abort("SIGINT"), 50);

    const result = await toText(await pending);
    expect(result.exitCode).toBe(130);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("maps abort reason SIGKILL to exit code 137", async () => {
    const bash = new Bash();
    const controller = new AbortController();

    const pending = bash.exec("sleep 30", { signal: controller.signal });
    setTimeout(() => controller.abort("SIGKILL"), 50);

    const result = await toText(await pending);
    expect(result.exitCode).toBe(137);
  });

  it("maps AbortSignal.timeout to exit code 124", async () => {
    const bash = new Bash();

    const result = await toText(
      await bash.exec("sleep 30", { signal: AbortSignal.timeout(50) }),
    );
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("cancels a loop that alternates output and sleeps", async () => {
    const controller = new AbortController();
    // Abort synchronously on the second iteration's mark: exactly two echos
    // have run, and the abort lands in the second sleep.
    const bash = new Bash({
      customCommands: [
        progressMark((count) => {
          if (count === 2) controller.abort();
        }),
      ],
    });

    const result = await toText(
      await bash.exec("while true; do echo x; mark; sleep 0.3; done", {
        signal: controller.signal,
      }),
    );
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toBe("x\nx\n");
    expect(result.stderr).toBe("");
  });

  it("cancels a statement-dense busy loop via the macrotask yield", async () => {
    // Without the periodic macrotask yield in executeStatement, a busy loop
    // only ever awaits resolved promises (microtasks), so the abort timer
    // would never fire until maxCommandCount trips.
    const bash = new Bash({
      executionLimits: {
        maxCommandCount: 100_000_000,
        maxLoopIterations: 100_000_000,
      },
    });

    const start = Date.now();
    const result = await toText(
      await bash.exec("while true; do :; done", {
        signal: AbortSignal.timeout(100),
      }),
    );
    expect(result.exitCode).toBe(124);
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it("propagates cancellation into nested bash -c executions", async () => {
    const controller = new AbortController();
    // mark runs inside the nested bash -c after its echo, so the abort
    // deterministically lands in the nested sleep.
    const bash = new Bash({
      customCommands: [
        progressMark(() => setTimeout(() => controller.abort(), 25)),
      ],
    });

    const start = Date.now();
    const result = await toText(
      await bash.exec("bash -c 'echo inner; mark; sleep 30'; echo outer", {
        signal: controller.signal,
      }),
    );
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toBe("inner\n");
    expect(result.stderr).toBe("");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("wakes a signal-aware custom sleep on abort", async () => {
    const bash = new Bash({
      sleep: (ms, signal) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        }),
    });
    const controller = new AbortController();

    const pending = bash.exec("sleep 30", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    const start = Date.now();
    const result = await toText(await pending);
    expect(result.exitCode).toBe(143);
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("delivers the abort after a signal-ignoring custom sleep resolves", async () => {
    const bash = new Bash({
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });
    const controller = new AbortController();

    const pending = bash.exec("sleep 0.2; echo after", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 20);

    const result = await toText(await pending);
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toBe("");
  });

  it("does not affect executions without a signal", async () => {
    const bash = new Bash();
    const result = await toText(await bash.exec("echo plain"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("plain\n");
    expect(result.stderr).toBe("");
  });
});
