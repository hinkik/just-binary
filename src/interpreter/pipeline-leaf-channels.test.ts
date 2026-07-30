import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { toText } from "../test-utils.js";
import { decode, encode } from "../utils/bytes.js";
import { emptyStream } from "../utils/stream.js";

describe("pipeline and leaf output channels", () => {
  it("keeps an intermediate custom producer lazy through head", async () => {
    let pullCount = 0;
    const chunk = encode("x".repeat(64 * 1024));
    const bash = new Bash({
      customCommands: [
        defineCommand("lazy-producer", async () => ({
          stdout: new ReadableStream<Uint8Array>({
            pull(controller) {
              pullCount++;
              if (pullCount > 16) {
                controller.error(
                  new Error("lazy producer was pulled past its tripwire"),
                );
                return;
              }
              controller.enqueue(chunk);
            },
          }),
          stderr: emptyStream(),
          exitCode: 0,
        })),
      ],
    });

    const result = await toText(await bash.exec("lazy-producer | head -c 10"));

    expect({
      stayedBounded: pullCount <= 8,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stayedBounded: true,
      stdout: "xxxxxxxxxx",
      stderr: "",
      exitCode: 0,
    });
  });

  it("appends each lazy leaf chunk before pulling the next chunk", async () => {
    const fs = new InMemoryFs({ "/growth.log": "" });
    const chunks = ["one\n", "two\n", "three\n"];
    const snapshots: string[] = [];
    let chunkIndex = 0;
    const bash = new Bash({
      fs,
      cwd: "/",
      customCommands: [
        defineCommand("chunk-writer", async () => ({
          stdout: new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (chunkIndex > 0) {
                const expected = chunks.slice(0, chunkIndex).join("");
                let observed = "";
                for (let attempt = 0; attempt < 100; attempt++) {
                  observed = await fs.readFileText("/growth.log");
                  if (observed === expected) {
                    break;
                  }
                  await Promise.resolve();
                }
                if (observed !== expected) {
                  controller.error(
                    new Error(
                      `append was not visible before pull ${chunkIndex + 1}`,
                    ),
                  );
                  return;
                }
                snapshots.push(observed);
              }

              if (chunkIndex === chunks.length) {
                controller.close();
                return;
              }
              controller.enqueue(encode(chunks[chunkIndex]));
              chunkIndex++;
            },
          }),
          stderr: emptyStream(),
          exitCode: 0,
        })),
      ],
    });

    const result = await toText(await bash.exec("chunk-writer >> growth.log"));

    expect({
      snapshots,
      file: await fs.readFileText("/growth.log"),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      snapshots: ["one\n", "one\ntwo\n", "one\ntwo\nthree\n"],
      file: "one\ntwo\nthree\n",
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("emits each executed statement-list pipeline exactly once", async () => {
    const chained = await toText(
      await new Bash().exec("echo a && echo b || echo c"),
    );
    const shortCircuited = await toText(
      await new Bash().exec("false && echo skip; echo after"),
    );

    expect({
      chained: {
        stdout: chained.stdout,
        stderr: chained.stderr,
        exitCode: chained.exitCode,
      },
      shortCircuited: {
        stdout: shortCircuited.stdout,
        stderr: shortCircuited.stderr,
        exitCode: shortCircuited.exitCode,
      },
    }).toEqual({
      chained: {
        stdout: "a\nb\n",
        stderr: "",
        exitCode: 0,
      },
      shortCircuited: {
        stdout: "after\n",
        stderr: "",
        exitCode: 0,
      },
    });
  });

  it("publishes the first AND-list pipeline before starting the second", async () => {
    let observed = "";
    let observedBeforeB = "";
    const bash = new Bash({
      customCommands: [
        defineCommand("emit-b", async () => {
          observedBeforeB = observed;
          return { stdout: "b\n", stderr: "", exitCode: 0 };
        }),
      ],
    });

    const result = await toText(
      await bash.exec("echo a && emit-b || echo c", {
        stdoutSink: {
          write(chunk) {
            observed += decode(chunk);
          },
        },
      }),
    );

    expect({
      observedBeforeB,
      observed,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observedBeforeB: "a\n",
      observed: "a\nb\n",
      stdout: "a\nb\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("publishes an intermediate stage's stderr before starting its consumer", async () => {
    let observedStderr = "";
    let observedBeforeConsumer = "";
    const bash = new Bash({
      customCommands: [
        defineCommand("stage-error", async () => ({
          stdout: "",
          stderr: "stage-error\n",
          exitCode: 0,
        })),
        defineCommand("observe-consumer", async () => {
          observedBeforeConsumer = observedStderr;
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });

    const result = await toText(
      await bash.exec("stage-error | observe-consumer", {
        stderrSink: {
          write(chunk) {
            observedStderr += decode(chunk);
          },
        },
      }),
    );

    expect({
      observedBeforeConsumer,
      observedStderr,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      observedBeforeConsumer: "stage-error\n",
      observedStderr: "stage-error\n",
      stdout: "",
      stderr: "stage-error\n",
      exitCode: 0,
    });
  });
});
