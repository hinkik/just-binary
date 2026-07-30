import { describe, expect, it } from "vitest";
import { Sandbox } from "./Sandbox.js";

describe("Command.kill()", () => {
  it("terminates a running command with SIGTERM", async () => {
    const sandbox = await Sandbox.create();
    const command = await sandbox.runCommand("sleep 5; echo unreachable");

    expect(command.pid).toBeGreaterThan(0);
    await expect(command.kill()).resolves.toBeUndefined();

    expect((await command.wait()).exitCode).toBe(143);
    expect(await command.stdout()).toBe("");
    expect(await command.stderr()).toBe("");
  });

  it("is harmless after a command has settled", async () => {
    const sandbox = await Sandbox.create();
    const command = await sandbox.runCommand("echo done");

    expect((await command.wait()).exitCode).toBe(0);
    await expect(command.kill()).resolves.toBeUndefined();
    expect(await command.stdout()).toBe("done\n");
    expect(await command.stderr()).toBe("");
  });
});
