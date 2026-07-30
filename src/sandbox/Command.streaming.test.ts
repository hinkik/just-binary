import { describe, expect, it } from "vitest";
import type { OutputMessage } from "./Command.js";
import { Sandbox } from "./Sandbox.js";

async function readLogs(
  logs: AsyncGenerator<OutputMessage, void, unknown>,
): Promise<OutputMessage[]> {
  const messages: OutputMessage[] = [];
  for await (const message of logs) {
    messages.push(message);
  }
  return messages;
}

describe("Command.logs() streaming", () => {
  it("yields output before the command completes", async () => {
    const sandbox = await Sandbox.create();
    const earliestTimestamp = Date.now();
    const command = await sandbox.runCommand(
      "echo first; sleep 5; echo unreachable",
    );
    const logs = command.logs();

    const first = await logs.next();
    const receivedAt = Date.now();

    expect(first.done).toBe(false);
    expect(first.value).toEqual({
      type: "stdout",
      data: "first\n",
      timestamp: expect.any(Date),
    });
    expect(first.value?.timestamp.getTime()).toBeGreaterThanOrEqual(
      earliestTimestamp,
    );
    expect(first.value?.timestamp.getTime()).toBeLessThanOrEqual(receivedAt);
    expect(command.exitCode).toBeUndefined();

    await command.kill();
    expect(await readLogs(logs)).toEqual([]);
    expect((await command.wait()).exitCode).toBe(143);
    expect(await command.stdout()).toBe("first\n");
    expect(await command.stderr()).toBe("");
  });

  it("replays timestamped chunks after completion", async () => {
    const sandbox = await Sandbox.create();
    const command = await sandbox.runCommand(
      "printf 'out\\n'; printf 'err\\n' >&2",
    );
    await command.wait();

    const firstRead = await readLogs(command.logs());
    const secondRead = await readLogs(command.logs());

    expect(firstRead).toEqual([
      {
        type: "stdout",
        data: "out\n",
        timestamp: expect.any(Date),
      },
      {
        type: "stderr",
        data: "err\n",
        timestamp: expect.any(Date),
      },
    ]);
    expect(secondRead).toEqual(firstRead);
    expect(await command.stdout()).toBe("out\n");
    expect(await command.stderr()).toBe("err\n");
  });
});
