import { describe, expect, it } from "vitest";
import type { RedirectionNode } from "../ast/types.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { resolveLimits } from "../limits.js";
import { parse } from "../parser/parser.js";
import { decode, encode, envSet } from "../utils/bytes.js";
import type { OutputChannels, OutputSink } from "./output-channels.js";
import { compileOutputRedirections } from "./redirect-channels.js";
import type { InterpreterContext, InterpreterState } from "./types.js";

function redirects(script: string): RedirectionNode[] {
  const command = parse(script).statements[0]?.pipelines[0]?.commands[0];
  if (command?.type !== "SimpleCommand") {
    throw new Error(`Expected a simple command: ${script}`);
  }
  return command.redirections;
}

function textSink(output: { value: string }): OutputSink {
  return {
    write(chunk) {
      output.value += decode(chunk);
    },
  };
}

function createContext(
  fs: InMemoryFs,
  outputChannels: OutputChannels,
): InterpreterContext {
  const env = new Map<string, Uint8Array>();
  envSet(env, "IFS", " \t\n");
  return {
    state: {
      env,
      cwd: "/",
      options: { noclobber: false, noglob: false },
      shoptOptions: {
        dotglob: false,
        extglob: false,
        failglob: false,
        globskipdots: true,
        globstar: false,
        nullglob: false,
      },
    } as InterpreterState,
    fs,
    outputChannels,
    limits: resolveLimits(),
  } as unknown as InterpreterContext;
}

function baseChannels(stdout: OutputSink, stderr: OutputSink): OutputChannels {
  return {
    bindings: new Map([
      [1, { sink: stdout }],
      [2, { sink: stderr }],
    ]),
  };
}

describe("output redirect channel sinks", () => {
  it("truncates once on install and serially appends every chunk", async () => {
    const fs = new InMemoryFs({ "/out": "old" });
    const original = baseChannels(
      textSink({ value: "" }),
      textSink({ value: "" }),
    );
    const ctx = createContext(fs, original);

    const compiled = await compileOutputRedirections(
      ctx,
      original,
      redirects(": >out"),
    );
    expect({
      error: compiled.error,
      installed: await fs.readFileText("/out"),
      originalUnchanged:
        original.bindings.get(1)?.sink !==
        compiled.channels.bindings.get(1)?.sink,
    }).toEqual({
      error: undefined,
      installed: "",
      originalUnchanged: true,
    });

    const sink = compiled.channels.bindings.get(1)?.sink;
    await sink?.write(encode("first"));
    expect(await fs.readFileText("/out")).toBe("first");
    await sink?.write(encode("-second"));
    expect(await fs.readFileText("/out")).toBe("first-second");
  });

  it("appends chunks without truncating for >>", async () => {
    const fs = new InMemoryFs({ "/out": "old" });
    const channels = baseChannels(
      textSink({ value: "" }),
      textSink({ value: "" }),
    );
    const ctx = createContext(fs, channels);
    const compiled = await compileOutputRedirections(
      ctx,
      channels,
      redirects(": >>out"),
    );
    const sink = compiled.channels.bindings.get(1)?.sink;

    const first = sink?.write(encode("-A"));
    const second = sink?.write(encode("-B"));
    await Promise.all([first, second]);
    expect(await fs.readFileText("/out")).toBe("old-A-B");
  });

  it("snapshots fd aliases in left-to-right order", async () => {
    const oldStdout = { value: "" };
    const oldStderr = { value: "" };
    const stdoutSink = textSink(oldStdout);
    const stderrSink = textSink(oldStderr);
    const original = baseChannels(stdoutSink, stderrSink);
    const fs = new InMemoryFs();
    const ctx = createContext(fs, original);

    const shared = await compileOutputRedirections(
      ctx,
      original,
      redirects(": >shared 2>&1"),
    );
    expect(shared.channels.bindings.get(2)?.sink).toBe(
      shared.channels.bindings.get(1)?.sink,
    );
    const sharedOne = shared.channels.bindings
      .get(1)
      ?.sink?.write(encode("one"));
    const sharedTwo = shared.channels.bindings
      .get(2)
      ?.sink?.write(encode("-two"));
    await Promise.all([sharedOne, sharedTwo]);

    const split = await compileOutputRedirections(
      ctx,
      original,
      redirects(": 2>&1 >split"),
    );
    expect({
      splitStderrIsOldStdout:
        split.channels.bindings.get(2)?.sink === stdoutSink,
      splitStdoutIsOldStdout:
        split.channels.bindings.get(1)?.sink === stdoutSink,
      originalStdout: original.bindings.get(1)?.sink === stdoutSink,
      originalStderr: original.bindings.get(2)?.sink === stderrSink,
    }).toEqual({
      splitStderrIsOldStdout: true,
      splitStdoutIsOldStdout: false,
      originalStdout: true,
      originalStderr: true,
    });
    await split.channels.bindings.get(2)?.sink?.write(encode("outside"));
    await split.channels.bindings.get(1)?.sink?.write(encode("inside"));

    expect({
      shared: await fs.readFileText("/shared"),
      split: await fs.readFileText("/split"),
      oldStdout: oldStdout.value,
      oldStderr: oldStderr.value,
    }).toEqual({
      shared: "one-two",
      split: "inside",
      oldStdout: "outside",
      oldStderr: "",
    });
  });

  it("installs special-device sinks using install-time snapshots", async () => {
    const stdout = { value: "" };
    const stderr = { value: "" };
    const stdoutSink = textSink(stdout);
    const stderrSink = textSink(stderr);
    const channels = baseChannels(stdoutSink, stderrSink);
    const ctx = createContext(new InMemoryFs(), channels);
    const compiled = await compileOutputRedirections(
      ctx,
      channels,
      redirects(": 3>/dev/stdout 4>/dev/stderr 5>/dev/null 6>/dev/full"),
    );

    expect({
      stdoutSnapshot: compiled.channels.bindings.get(3)?.sink === stdoutSink,
      stderrSnapshot: compiled.channels.bindings.get(4)?.sink === stderrSink,
    }).toEqual({ stdoutSnapshot: true, stderrSnapshot: true });
    await compiled.channels.bindings.get(5)?.sink?.write(encode("discarded"));

    let fullError: unknown;
    try {
      await compiled.channels.bindings.get(6)?.sink?.write(encode("fails"));
    } catch (error) {
      fullError = error;
    }
    expect({
      stdout: stdout.value,
      stderr: stderr.value,
      fullError:
        fullError instanceof Error
          ? {
              message: fullError.message,
              code: (fullError as Error & { code?: string }).code,
            }
          : fullError,
    }).toEqual({
      stdout: "",
      stderr: "",
      fullError: {
        message: "bash: echo: write error: No space left on device\n",
        code: "ENOSPC",
      },
    });
  });
});
