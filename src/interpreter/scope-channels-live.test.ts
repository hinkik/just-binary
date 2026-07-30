import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import type { InitialFiles } from "../fs/interface.js";
import { toText } from "../test-utils.js";
import { decode, encode } from "../utils/bytes.js";
import { emptyStream } from "../utils/stream.js";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function deferred(): Deferred {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

interface LiveBoundaryCase {
  name: string;
  script: string;
  files?: InitialFiles;
}

const liveBoundaries: LiveBoundaryCase[] = [
  {
    name: "group",
    script: "{ gated-output; }",
  },
  {
    name: "subshell",
    script: "(gated-output)",
  },
  {
    name: "function loop body",
    script: "f() { for i in one; do gated-output; done; }; f",
  },
  {
    name: "eval",
    script: "eval 'gated-output'",
  },
  {
    name: "source",
    script: "source /scope-source",
    files: { "/scope-source": "gated-output" },
  },
  {
    name: "user script",
    script: "/scope-script",
    files: {
      "/scope-script": {
        content: "#!/bin/bash\ngated-output",
        mode: 0o755,
      },
    },
  },
];

describe("scope live output channels", () => {
  it.each(
    liveBoundaries,
  )("publishes a chunk before the $name completes", async ({
    files,
    script,
  }) => {
    const releaseSecond = deferred();
    const firstObserved = deferred();
    let pullCount = 0;
    let observed = "";
    let execResolved = false;
    const gatedOutput = defineCommand("gated-output", async () => ({
      stdout: new ReadableStream<Uint8Array>({
        async pull(controller) {
          pullCount++;
          if (pullCount === 1) {
            controller.enqueue(encode("A"));
            return;
          }
          await releaseSecond.promise;
          controller.enqueue(encode("B"));
          controller.close();
        },
      }),
      stderr: emptyStream(),
      exitCode: 0,
    }));
    const bash = new Bash({
      cwd: "/",
      files,
      customCommands: [gatedOutput],
    });

    const pending = bash
      .exec(script, {
        stdoutSink: {
          write(chunk) {
            observed += decode(chunk);
            firstObserved.resolve();
          },
        },
      })
      .then((result) => {
        execResolved = true;
        return result;
      });

    await firstObserved.promise;
    expect({ execResolved, observed }).toEqual({
      execResolved: false,
      observed: "A",
    });

    releaseSecond.resolve();
    const result = await toText(await pending);
    expect({
      observed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observed: "AB",
      stdout: "AB",
      stderr: "",
      exitCode: 0,
    });
  });

  it("publishes each nested bash result before the loop advances", async () => {
    let observed = "";
    let marks = 0;
    let liveAtEveryMark = true;
    const bash = new Bash({
      customCommands: [
        defineCommand("mark", async () => {
          marks++;
          liveAtEveryMark =
            liveAtEveryMark && observed === "inner\n".repeat(marks);
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });

    const result = await toText(
      await bash.exec("for i in 1 2; do bash -c 'echo inner'; mark; done", {
        stdoutSink: {
          write(chunk) {
            observed += decode(chunk);
          },
        },
      }),
    );

    expect({
      liveAtEveryMark,
      marks,
      observed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      liveAtEveryMark: true,
      marks: 2,
      observed: "inner\ninner\n",
      stdout: "inner\ninner\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps ordinary leaf output buffered until its statement completes", async () => {
    const blocked = deferred();
    const blockedStarted = deferred();
    let observed = "";
    let execResolved = false;
    const bash = new Bash({
      customCommands: [
        defineCommand("legacy-output", async () => ({
          stdout: "legacy\n",
          stderr: "",
          exitCode: 0,
        })),
        defineCommand("blocked-leaf", async () => {
          blockedStarted.resolve();
          await blocked.promise;
          return { stdout: "done\n", stderr: "", exitCode: 0 };
        }),
      ],
    });

    const pending = bash
      .exec("legacy-output && blocked-leaf", {
        stdoutSink: {
          write(chunk) {
            observed += decode(chunk);
          },
        },
      })
      .then((result) => {
        execResolved = true;
        return result;
      });

    await blockedStarted.promise;
    expect({ execResolved, observed }).toEqual({
      execResolved: false,
      observed: "",
    });

    blocked.resolve();
    const result = await toText(await pending);
    expect({
      observed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observed: "legacy\ndone\n",
      stdout: "legacy\ndone\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
