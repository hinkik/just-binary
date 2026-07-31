import { describe, expect, it } from "vitest";
import { Sandbox } from "./Sandbox.js";

describe("Sandbox process-table isolation", () => {
  it("does not expose an enclosing Command as a shell job", async () => {
    const sandbox = await Sandbox.create();
    const command = await sandbox.runCommand("sleep 5");

    expect(sandbox.bashEnvInstance.processes.list()).toEqual([]);

    await command.kill();
    expect((await command.wait()).exitCode).toBe(143);
    expect(await command.stdout()).toBe("");
    expect(await command.stderr()).toBe("");
  });

  it("gives sequential commands independent shell job namespaces", async () => {
    const sandbox = await Sandbox.create();
    const first = await sandbox.runCommand("sleep 1 & printf 'first\\n'");

    expect((await first.wait()).exitCode).toBe(0);
    expect(await first.stdout()).toBe("first\n");
    expect(await first.stderr()).toBe("");

    const startedAt = performance.now();
    const second = await sandbox.runCommand("jobs; wait; printf 'second\\n'");
    expect((await second.wait()).exitCode).toBe(0);
    const elapsedMs = performance.now() - startedAt;

    expect(await second.stdout()).toBe("second\n");
    expect(await second.stderr()).toBe("");
    expect(elapsedMs).toBeLessThan(500);
    await sandbox.stop();
  });

  it("keeps nested background jobs out of the next command's namespace", async () => {
    const sandbox = await Sandbox.create();
    const first = await sandbox.runCommand("bash -c 'sleep 1 &'");

    expect((await first.wait()).exitCode).toBe(0);
    const startedAt = performance.now();
    const second = await sandbox.runCommand("wait; printf 'isolated\\n'");
    expect((await second.wait()).exitCode).toBe(0);

    expect({
      stdout: await second.stdout(),
      stderr: await second.stderr(),
    }).toEqual({
      stdout: "isolated\n",
      stderr: "",
    });
    expect(performance.now() - startedAt).toBeLessThan(500);
    await sandbox.stop();
  });

  it("disposes a command's shell table after background jobs settle", async () => {
    const sandbox = await Sandbox.create();
    const command = await sandbox.runCommand("sleep 0.01 &");
    const commandProbe = command as unknown as {
      shellProcesses: {
        list(): unknown[];
        runningCount: number;
        start(command: string, runner: () => Promise<number>): number;
      };
    };

    expect((await command.wait()).exitCode).toBe(0);
    // Bounded: a reaping regression should fail this assertion, not hang the run.
    const reapDeadline = Date.now() + 5_000;
    while (commandProbe.shellProcesses.runningCount > 0) {
      expect(Date.now()).toBeLessThan(reapDeadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(commandProbe.shellProcesses.list()).toEqual([]);
    expect(() =>
      commandProbe.shellProcesses.start("late", async () => 0),
    ).toThrow("Cannot start a job on a disposed ProcessTable");
    await sandbox.stop();
  });
});
