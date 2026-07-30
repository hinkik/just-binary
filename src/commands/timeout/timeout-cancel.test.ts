import { describe, expect, it } from "vitest";
import { Bash } from "../../Bash.js";
import { defineCommand } from "../../custom-commands.js";
import { toText } from "../../test-utils.js";
import { decode } from "../../utils/bytes.js";

function outerAbortSetup(): {
  bash: Bash;
  controller: AbortController;
} {
  const controller = new AbortController();
  const mark = defineCommand("mark", async () => {
    setTimeout(() => controller.abort("SIGTERM"), 25);
    return { stdout: "", stderr: "", exitCode: 0 };
  });
  return {
    bash: new Bash({ customCommands: [mark] }),
    controller,
  };
}

// timeout now cancels its child through the exec AbortSignal instead of
// racing and leaking it. These tests exercise the cancellation path.
describe("timeout command cancellation", () => {
  it("kills the child at the deadline and passes partial output through", async () => {
    const bash = new Bash();

    const start = Date.now();
    // 0.5s deadline: wide enough that `echo part` always beats it, even on a
    // loaded machine running the full suite.
    const result = await toText(
      await bash.exec("timeout 0.5 bash -c 'echo part; sleep 30; echo never'"),
    );
    expect(result.exitCode).toBe(124);
    expect(result.stdout).toBe("part\n");
    expect(result.stderr).toBe("");
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  it("reports the child's SIGTERM status with --preserve-status", async () => {
    const bash = new Bash();

    const result = await toText(
      await bash.exec("timeout --preserve-status 0.1 sleep 30"),
    );
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("returns the child's result when it finishes in time", async () => {
    const bash = new Bash();

    const result = await toText(
      await bash.exec("timeout 10 bash -c 'echo done; exit 3'"),
    );
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("done\n");
    expect(result.stderr).toBe("");
  });

  it("propagates an outer abort instead of reporting 124", async () => {
    const bash = new Bash();
    const controller = new AbortController();

    const pending = bash.exec("timeout 30 sleep 60; echo after", {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const start = Date.now();
    const result = await toText(await pending);
    // The whole script was cancelled: 143, not timeout's own 124.
    expect(result.exitCode).toBe(143);
    expect(result.stdout).toBe("");
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("preserves nested output through returned streams and host sinks on outer abort", async () => {
    const { bash, controller } = outerAbortSetup();
    let observedStdout = "";
    let observedStderr = "";

    const result = await toText(
      await bash.exec(
        "timeout 30 bash -c 'printf out; printf err >&2; mark; sleep 30'",
        {
          signal: controller.signal,
          stdoutSink: {
            write(chunk) {
              observedStdout += decode(chunk);
            },
          },
          stderrSink: {
            write(chunk) {
              observedStderr += decode(chunk);
            },
          },
        },
      ),
    );

    expect({
      observedStdout,
      observedStderr,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observedStdout: "out",
      observedStderr: "err",
      stdout: "out",
      stderr: "err",
      exitCode: 143,
    });
  });

  it("preserves nested output when timeout is an intermediate pipeline stage", async () => {
    const { bash, controller } = outerAbortSetup();
    const result = await toText(
      await bash.exec(
        "timeout 30 bash -c 'printf out; printf err >&2; mark; sleep 30' | cat",
        { signal: controller.signal },
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 143,
    });
  });

  it("finishes active timeout redirections before propagating an outer abort", async () => {
    const { bash, controller } = outerAbortSetup();
    const result = await toText(
      await bash.exec(
        "timeout 30 bash -c 'printf out; printf err >&2; mark; sleep 30' > /partial 2> /partial-err",
        { signal: controller.signal },
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      stdoutFile: await bash.fs.readFileText("/partial"),
      stderrFile: await bash.fs.readFileText("/partial-err"),
    }).toEqual({
      stdout: "",
      stderr: "",
      exitCode: 143,
      stdoutFile: "out",
      stderrFile: "err",
    });
  });

  it("does not execute an OR-list continuation after an outer abort", async () => {
    const { bash, controller } = outerAbortSetup();
    const result = await toText(
      await bash.exec(
        "timeout 30 bash -c 'printf out; printf err >&2; mark; sleep 30' || echo never",
        { signal: controller.signal },
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "out",
      stderr: "err",
      exitCode: 143,
    });
  });

  it("forwards stdin to the child", async () => {
    const bash = new Bash();

    const result = await toText(await bash.exec("echo data | timeout 10 cat"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("data\n");
    expect(result.stderr).toBe("");
  });
});
