import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ProcessTable } from "../process/process-table.js";
import { type TextResult, toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";
import type { OutputSink } from "./output-channels.js";

function expectResult(
  result: TextResult,
  expected: { stdout: string; stderr: string; exitCode: number },
): void {
  expect({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }).toEqual(expected);
}

describe("Bash background-job output", () => {
  it("observes output and exit after the originating exec snapshot returns", async () => {
    const output: Array<[number, number, string]> = [];
    const exits: Array<[number, number]> = [];
    const forwarded: string[] = [];
    const processes = new ProcessTable({
      onJobOutput: (pid, fd, chunk) => {
        output.push([pid, fd, decode(chunk)]);
      },
      onJobExit: (pid, exitCode) => exits.push([pid, exitCode]),
    });
    const stdoutSink: OutputSink = {
      write(chunk) {
        forwarded.push(decode(chunk));
      },
    };
    const result = await toText(
      await new Bash({ processes }).exec(
        "{ sleep 0.02; echo late; echo error >&2; } &",
        { stdoutSink },
      ),
    );

    expectResult(result, {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });

    expect(await processes.wait(1000)).toBe(0);
    expect(output).toEqual([
      [1000, 1, "late\n"],
      [1000, 2, "error\n"],
    ]);
    expect(forwarded).toEqual(["late\n"]);
    expect(exits).toEqual([[1000, 0]]);
  });

  it("keeps the returned root streams as an immutable point-in-time snapshot", async () => {
    const processes = new ProcessTable();
    const bash = new Bash({ processes });
    const rawResult = await bash.exec(
      "{ sleep 0.02; printf after-snapshot; } &",
    );
    const result = await toText(rawResult);

    expectResult(result, {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(await processes.wait(1000)).toBe(0);
    expect(processes.get(1000)?.exitCode).toBe(0);
  });
});
