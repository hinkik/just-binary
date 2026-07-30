import { describe, expect, it } from "vitest";
import { Sandbox } from "./Sandbox.js";

describe("Sandbox.stop()", () => {
  it("terminates every running command", async () => {
    const sandbox = await Sandbox.create();
    const first = await sandbox.runCommand("sleep 5; echo first");
    const second = await sandbox.runCommand("sleep 5; echo second");

    await expect(sandbox.stop()).resolves.toBeUndefined();

    expect([
      (await first.wait()).exitCode,
      (await second.wait()).exitCode,
    ]).toEqual([137, 137]);
    expect(await first.stdout()).toBe("");
    expect(await first.stderr()).toBe("");
    expect(await second.stdout()).toBe("");
    expect(await second.stderr()).toBe("");
  });

  it("also terminates shell jobs that outlive their command", async () => {
    const sandbox = await Sandbox.create();
    const command = await sandbox.runCommand("sleep 5 &");

    expect((await command.wait()).exitCode).toBe(0);
    expect(await command.stdout()).toBe("");
    expect(await command.stderr()).toBe("");
    const [job] = sandbox.bashEnvInstance.processes.list();
    const settled = sandbox.bashEnvInstance.processes.wait(job.pid);

    await sandbox.stop();

    expect(await settled).toBe(137);
    expect(sandbox.bashEnvInstance.processes.list()).toEqual([]);
  });

  it("can be called repeatedly", async () => {
    const sandbox = await Sandbox.create();

    await sandbox.stop();
    await expect(sandbox.stop()).resolves.toBeUndefined();
  });
});
