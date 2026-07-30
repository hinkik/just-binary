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
});
