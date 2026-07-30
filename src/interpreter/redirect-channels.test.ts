import { describe, expect, it } from "vitest";
import { AST, type RedirectionNode } from "../ast/types.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { resolveLimits } from "../limits.js";
import { parse } from "../parser/parser.js";
import { toText } from "../test-utils.js";
import { decode, envGet, envSet } from "../utils/bytes.js";
import type { OutputChannels, OutputSink } from "./output-channels.js";
import {
  applyPersistentOutputRedirections,
  compileOutputRedirections,
} from "./redirect-channels.js";
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
  const state = {
    env,
    cwd: "/",
    options: {
      noclobber: false,
      noglob: false,
    },
    shoptOptions: {
      dotglob: false,
      extglob: false,
      failglob: false,
      globskipdots: true,
      globstar: false,
      nullglob: false,
    },
    fileDescriptors: new Map<number, string>(),
    nextFd: 10,
  } as InterpreterState;

  return {
    state,
    fs,
    outputChannels,
    limits: resolveLimits(),
  } as unknown as InterpreterContext;
}

function baseChannels(stdout: OutputSink, stderr: OutputSink): OutputChannels {
  return new Map([
    [1, stdout],
    [2, stderr],
  ]);
}

describe("output redirect channel compilation", () => {
  it("removes closed fds without mutating the input table", async () => {
    const channels = baseChannels(
      textSink({ value: "" }),
      textSink({ value: "" }),
    );
    const ctx = createContext(new InMemoryFs(), channels);
    const compiled = await compileOutputRedirections(
      ctx,
      channels,
      redirects(": 2>&-"),
    );

    expect({
      compiledHasFd2: compiled.channels.has(2),
      inputHasFd2: channels.has(2),
    }).toEqual({ compiledHasFd2: false, inputHasFd2: true });
  });

  it("returns exact noclobber and invalid-fd diagnostics", async () => {
    const fs = new InMemoryFs({ "/out": "old" });
    const channels = baseChannels(
      textSink({ value: "" }),
      textSink({ value: "" }),
    );
    const ctx = createContext(fs, channels);
    ctx.state.options.noclobber = true;

    const noclobber = await compileOutputRedirections(
      ctx,
      channels,
      redirects(": >out"),
    );
    const badFd = await compileOutputRedirections(
      ctx,
      channels,
      redirects(": 2>&9"),
    );

    expect({
      noclobber: await toText(
        noclobber.error as NonNullable<typeof noclobber.error>,
      ),
      badFd: await toText(badFd.error as NonNullable<typeof badFd.error>),
      file: await fs.readFileText("/out"),
    }).toEqual({
      noclobber: {
        stdout: "",
        stderr: "bash: out: cannot overwrite existing file\n",
        exitCode: 1,
      },
      badFd: {
        stdout: "",
        stderr: "bash: 9: Bad file descriptor\n",
        exitCode: 1,
      },
      file: "old",
    });
  });

  it("reports input redirects unchanged for the legacy caller", async () => {
    const channels = baseChannels(
      textSink({ value: "" }),
      textSink({ value: "" }),
    );
    const ctx = createContext(new InMemoryFs(), channels);
    const input = redirects(": <in 3<&0 4<>rw <<<text");
    input.push(
      AST.redirection(
        "<<",
        AST.hereDoc("EOF", AST.word([AST.literal("body\n")])),
      ),
    );
    const output = redirects(": 5>out");
    const redirections = [...input, ...output];
    const compiled = await compileOutputRedirections(
      ctx,
      channels,
      redirections,
    );

    expect({
      freshTable: compiled.channels !== channels,
      legacyRedirections: compiled.legacyRedirections,
      outputInstalled: compiled.channels.has(5),
    }).toEqual({
      freshTable: true,
      legacyRedirections: input,
      outputInstalled: true,
    });
  });

  it("compiles explicit stdout and stderr <& duplication as output", async () => {
    const stdout = { value: "" };
    const stderr = { value: "" };
    const channels = baseChannels(textSink(stdout), textSink(stderr));
    const ctx = createContext(new InMemoryFs(), channels);
    const compiled = await compileOutputRedirections(
      ctx,
      channels,
      redirects(": 1<&2 2<&1"),
    );

    expect({
      legacyRedirections: compiled.legacyRedirections,
      stdoutUsesOriginalStderr: compiled.channels.get(1) === channels.get(2),
      stderrUsesOriginalStderr: compiled.channels.get(2) === channels.get(2),
    }).toEqual({
      legacyRedirections: [],
      stdoutUsesOriginalStderr: true,
      stderrUsesOriginalStderr: true,
    });
  });

  it("snapshots fd-variable metadata before the source is closed", async () => {
    const channels = baseChannels(
      textSink({ value: "" }),
      textSink({ value: "" }),
    );
    const ctx = createContext(new InMemoryFs(), channels);
    const compiled = await compileOutputRedirections(
      ctx,
      channels,
      redirects(": {source}>chain {copy}>&$source {source}>&-"),
    );

    expect({
      values: ["source", "copy"].map((name) => envGet(ctx.state.env, name)),
      sourceOpen: compiled.channels.has(10),
      copyOpen: compiled.channels.has(11),
      descriptors: [...(ctx.state.fileDescriptors ?? new Map()).entries()],
    }).toEqual({
      values: ["10", "11"],
      sourceOpen: false,
      copyOpen: true,
      descriptors: [[11, "__file__:/chain"]],
    });

    const orderedChannels = baseChannels(
      textSink({ value: "" }),
      textSink({ value: "" }),
    );
    const orderedCtx = createContext(new InMemoryFs(), orderedChannels);
    const ordered = await compileOutputRedirections(
      orderedCtx,
      orderedChannels,
      redirects(": >ordered {copy}>&1"),
    );
    expect({
      copyIsRedirectedStdout:
        ordered.channels.get(10) === ordered.channels.get(1),
      descriptor: orderedCtx.state.fileDescriptors?.get(10),
    }).toEqual({
      copyIsRedirectedStdout: true,
      descriptor: "__file__:/ordered",
    });
  });

  it("allocates fd variables and can persistently mutate a live table", async () => {
    const stdout = { value: "" };
    const channels = baseChannels(textSink(stdout), textSink({ value: "" }));
    const fs = new InMemoryFs({ "/append": "old" });
    const ctx = createContext(fs, channels);
    const allocated = await compileOutputRedirections(
      ctx,
      channels,
      redirects(": {out}>file {app}>>append {copy}>&1"),
    );

    expect({
      values: ["out", "app", "copy"].map((name) => envGet(ctx.state.env, name)),
      nextFd: ctx.state.nextFd,
      descriptors: [...(ctx.state.fileDescriptors ?? new Map()).entries()],
      copyIsStdout: allocated.channels.get(12) === channels.get(1),
    }).toEqual({
      values: ["10", "11", "12"],
      nextFd: 13,
      descriptors: [
        [10, "__file__:/file"],
        [11, "__file__:/append"],
        [12, "__dupout__:1"],
      ],
      copyIsStdout: true,
    });

    const live = ctx.outputChannels;
    const persistent = await applyPersistentOutputRedirections(
      ctx,
      redirects(": >persistent 2>&1 <input"),
    );
    expect({
      sameLiveTable: persistent.channels === live,
      stdoutAndStderrAlias: live.get(1) === live.get(2),
      legacy: persistent.legacyRedirections,
      descriptors: [...(ctx.state.fileDescriptors ?? new Map()).entries()],
    }).toEqual({
      sameLiveTable: true,
      stdoutAndStderrAlias: true,
      legacy: redirects(": <input"),
      descriptors: [
        [10, "__file__:/file"],
        [11, "__file__:/append"],
        [12, "__dupout__:1"],
        [1, "__file__:/persistent"],
        [2, "__file__:/persistent"],
      ],
    });
  });
});
