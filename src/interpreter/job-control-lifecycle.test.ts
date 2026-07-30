import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { ProcessTable } from "../process/process-table.js";
import { DefenseInDepthBox } from "../security/defense-in-depth-box.js";
import { type TextResult, toText } from "../test-utils.js";

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

function sleepUntilAborted(
  _milliseconds: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

describe("Bash background-job lifecycle", () => {
  it("keeps internal job scheduling available under defense-in-depth", async () => {
    DefenseInDepthBox.resetInstance();
    try {
      const result = await toText(
        await new Bash({ defenseInDepth: true }).exec("true & wait"),
      );

      expectResult(result, {
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    } finally {
      DefenseInDepthBox.resetInstance();
    }
  });

  it("lets an ambient abort interrupt wait on a shared job", async () => {
    const processes = new ProcessTable();
    let markWaitStarted: () => void = () => undefined;
    const waitStarted = new Promise<void>((resolve) => {
      markWaitStarted = resolve;
    });
    const wait = processes.wait.bind(processes);
    processes.wait = (pid?: number) => {
      markWaitStarted();
      return wait(pid);
    };
    const pid = processes.start(
      "shared",
      (_pid, signal) =>
        new Promise<number>((_resolve, reject) => {
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), {
            once: true,
          });
        }),
    );
    const controller = new AbortController();
    const pending = new Bash({ processes }).exec(`wait ${pid}`, {
      signal: controller.signal,
    });

    await waitStarted;
    controller.abort("SIGINT");
    const result = await toText(await pending);
    const settled = processes.wait(pid);
    processes.dispose();

    expectResult(result, {
      stdout: "",
      stderr: "",
      exitCode: 130,
    });
    expect(await settled).toBe(137);
  });

  it("caps concurrently running jobs", async () => {
    const processes = new ProcessTable();
    const bash = new Bash({
      processes,
      sleep: sleepUntilAborted,
      executionLimits: { maxConcurrentJobs: 1 },
    });
    const result = await toText(await bash.exec("sleep 9 & sleep 9 &"));

    expectResult(result, {
      stdout: "",
      stderr: "bash: maximum concurrent jobs (1) exceeded\n",
      exitCode: 1,
    });
    expect(
      processes.list().map(({ command, state }) => ({ command, state })),
    ).toEqual([{ command: "sleep 9 &", state: "running" }]);

    processes.abortAll();
    expect(await processes.wait()).toBe(0);
  });

  it("isolates a background job's environment and cwd from its parent", async () => {
    const result = await toText(
      await new Bash().exec(`
        X=parent
        { cd /tmp; X=child; export Y=child; } &
        wait
        printf "%s|%s|%s\\n" "$PWD" "$X" "\${Y-unset}"
      `),
    );

    expectResult(result, {
      stdout: "/home/user|parent|unset\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("shares one process table across three throwaway Bash instances", async () => {
    const processes = new ProcessTable();
    const starter = new Bash({
      processes,
      sleep: sleepUntilAborted,
    });
    const killer = new Bash({ processes });
    const observer = new Bash({ processes });

    const started = await toText(
      await starter.exec('sleep 9 & printf "%s\\n" "$!"'),
    );
    const listed = await toText(await observer.exec("jobs"));
    const killed = await toText(await killer.exec("kill 1000; wait 1000"));

    expectResult(started, {
      stdout: "1000\n",
      stderr: "",
      exitCode: 0,
    });
    expectResult(listed, {
      stdout: "[1]+  Running                 sleep 9 &\n",
      stderr: "",
      exitCode: 0,
    });
    expectResult(killed, {
      stdout: "",
      stderr: "",
      exitCode: 143,
    });
  });

  it("dispose aborts a job started through Bash and clears the table", async () => {
    const processes = new ProcessTable();
    const bash = new Bash({
      processes,
      sleep: sleepUntilAborted,
    });
    const started = await toText(await bash.exec("sleep 9 &"));
    const settled = processes.wait(1000);

    processes.dispose();

    expectResult(started, {
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(await settled).toBe(137);
    expect(processes.list()).toEqual([]);
  });
});
