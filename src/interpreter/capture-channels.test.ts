import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import type { TextResult } from "../test-utils.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";
import { type ByteStream, CHUNK_SIZE } from "../utils/stream.js";

interface ObservedExecution extends TextResult {
  observedStdout: string;
  observedStderr: string;
}

async function executeObserved(
  script: string,
  bash = new Bash(),
): Promise<ObservedExecution> {
  let observedStdout = "";
  let observedStderr = "";
  const result = await toText(
    await bash.exec(script, {
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
    }),
  );

  return { observedStdout, observedStderr, ...result };
}

function outputOf(result: ObservedExecution) {
  return {
    observedStdout: result.observedStdout,
    observedStderr: result.observedStderr,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

class PullCountingFs extends InMemoryFs {
  readonly totalChunks = 1024;
  pulls = 0;

  constructor() {
    super({ "/large.bin": "" });
  }

  override async readFile(path: string): Promise<ByteStream> {
    if (path !== "/large.bin") {
      return super.readFile(path);
    }

    const chunk = new Uint8Array(CHUNK_SIZE).fill(0x41);
    return new ReadableStream<Uint8Array>({
      pull: (controller) => {
        if (this.pulls === this.totalChunks) {
          controller.close();
          return;
        }
        this.pulls++;
        controller.enqueue(chunk);
      },
    });
  }
}

describe("capture output channels", () => {
  it("isolates dollar and backtick substitution stdout from the host sink", async () => {
    for (const script of [
      "out=$(echo inner); echo got:$out",
      "out=`echo inner`; echo got:$out",
    ]) {
      const result = await executeObserved(script);

      expect(outputOf(result)).toEqual({
        observedStdout: "got:inner\n",
        observedStderr: "",
        stdout: "got:inner\n",
        stderr: "",
        exitCode: 0,
      });
    }
  });

  it("keeps substitution stderr out of the captured value", async () => {
    const result = await executeObserved(
      'out=$(echo e >&2; echo v); echo "$out"',
    );

    expect(outputOf(result)).toEqual({
      observedStdout: "v\n",
      observedStderr: "e\n",
      stdout: "v\n",
      stderr: "e\n",
      exitCode: 0,
    });
  });

  it("captures stdout carried by ExitError exactly once", async () => {
    const result = await executeObserved(
      'out=$(printf before; exit 7); echo "st=$? out=$out"',
    );

    expect(outputOf(result)).toEqual({
      observedStdout: "st=7 out=before\n",
      observedStderr: "",
      stdout: "st=7 out=before\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps nested substitution captures isolated", async () => {
    const result = await executeObserved('a=$(echo $(echo deep)); echo "$a"');

    expect(outputOf(result)).toEqual({
      observedStdout: "deep\n",
      observedStderr: "",
      stdout: "deep\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves multi-stage pipeline output", async () => {
    const result = await executeObserved("echo a | tr a-z A-Z | rev");

    expect(outputOf(result)).toEqual({
      observedStdout: "A\n",
      observedStderr: "",
      stdout: "A\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("does not eagerly drain a lazy file producer before head exits", async () => {
    const fs = new PullCountingFs();
    const result = await executeObserved(
      "cat /large.bin | head -c 5",
      new Bash({ fs, cwd: "/" }),
    );

    expect(outputOf(result)).toEqual({
      observedStdout: "AAAAA",
      observedStderr: "",
      stdout: "AAAAA",
      stderr: "",
      exitCode: 0,
    });
    expect(fs.pulls).toBeLessThan(fs.totalChunks);
  });

  it("keeps compgen function output inside nested captures", async () => {
    const result = await executeObserved(`
      _complete() {
        printf 'callback\n'
        COMPREPLY=(one two)
      }
      captured=$(compgen -F _complete)
    `);

    expect(outputOf(result)).toEqual({
      observedStdout: "",
      observedStderr: "",
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
    expect(result.env?.captured).toBe("callback\none\ntwo");
  });
});
