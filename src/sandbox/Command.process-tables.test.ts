import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { Command } from "./Command.js";

describe("Command process-table defaults", () => {
  it("keeps direct-construction background jobs in the Bash namespace", async () => {
    const bash = new Bash();
    const command = new Command(bash, "sleep 1 &", bash.getCwd());

    expect((await command.wait()).exitCode).toBe(0);
    expect(
      bash.processes.list().map(({ command: jobCommand, state }) => ({
        command: jobCommand,
        state,
      })),
    ).toEqual([{ command: "sleep 1 &", state: "running" }]);

    bash.processes.abortAll();
    expect(await bash.processes.wait()).toBe(0);
  });
});
