import { describe, expect, it } from "vitest";
import { defineCommand } from "../custom-commands.js";
import { checkAborted } from "../interpreter/errors.js";
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

  it("awaits cleanup for shell jobs that outlive their command", async () => {
    const sandbox = await Sandbox.create();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let cleanupFinished = false;
    sandbox.bashEnvInstance.registerCommand(
      defineCommand("delayed-cleanup", async (_args, ctx) => {
        markStarted();
        await new Promise<void>((resolve) => {
          const finish = () => {
            setTimeout(() => {
              cleanupFinished = true;
              resolve();
            }, 25);
          };
          if (ctx.signal?.aborted) {
            finish();
          } else {
            ctx.signal?.addEventListener("abort", finish, { once: true });
          }
        });
        checkAborted(ctx.signal);
        return { stdout: "", stderr: "", exitCode: 0 };
      }),
    );
    const command = await sandbox.runCommand("delayed-cleanup &");

    expect((await command.wait()).exitCode).toBe(0);
    expect(await command.stdout()).toBe("");
    expect(await command.stderr()).toBe("");
    await started;

    await sandbox.stop();

    expect(cleanupFinished).toBe(true);
    expect(sandbox.bashEnvInstance.processes.list()).toEqual([]);
  });

  it("rejects commands after stop with a public API error", async () => {
    const sandbox = await Sandbox.create();
    await sandbox.stop();

    await expect(sandbox.runCommand("true")).rejects.toThrow(
      "Cannot run commands after Sandbox.stop()",
    );
  });

  it("can be called repeatedly", async () => {
    const sandbox = await Sandbox.create();

    await sandbox.stop();
    await expect(sandbox.stop()).resolves.toBeUndefined();
  });
});
