import { describe, expect, it } from "vitest";
import { Sandbox } from "./Sandbox.js";

describe("Command.kill()", () => {
  it.each([
    ["the default signal", undefined, 143],
    ["SIGTERM", "SIGTERM" as const, 143],
    ["SIGINT", "SIGINT" as const, 130],
    ["SIGKILL", "SIGKILL" as const, 137],
  ])("terminates a running command with %s", async (_name, signal, exitCode) => {
    const sandbox = await Sandbox.create();
    const command = await sandbox.runCommand("sleep 5; echo unreachable");

    expect(command.pid).toBeGreaterThan(0);
    await expect(command.kill(signal)).resolves.toBeUndefined();

    expect({
      exitCode: (await command.wait()).exitCode,
      stdout: await command.stdout(),
      stderr: await command.stderr(),
    }).toEqual({
      exitCode,
      stdout: "",
      stderr: "",
    });
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
