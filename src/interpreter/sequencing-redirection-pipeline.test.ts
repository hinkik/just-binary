import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { defineCommand } from "../custom-commands.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { toText } from "../test-utils.js";

describe("sequencing redirections and pipelines", () => {
  it("appends compound output after every completed iteration", async () => {
    const fs = new InMemoryFs({ "/f": "" });
    const snapshots: string[] = [];
    const bash = new Bash({
      fs,
      cwd: "/",
      customCommands: [
        defineCommand("mark", async () => {
          snapshots.push(await fs.readFileText("/f"));
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });

    const result = await toText(
      await bash.exec(
        "i=1; while test $i -le 3; do echo $i; mark; i=$((i + 1)); done >> f",
      ),
    );

    expect({
      snapshots,
      file: await fs.readFileText("/f"),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      snapshots: ["1\n", "1\n2\n", "1\n2\n3\n"],
      file: "1\n2\n3\n",
      stdout: "",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves fd-variable and noclobber compound semantics", async () => {
    const fdResult = await toText(
      await new Bash({ cwd: "/" }).exec(
        'for i in 1; do echo outer; echo inner >&$fd; done {fd}>f; echo "fd:$fd"; cat f',
      ),
    );
    expect({
      stdout: fdResult.stdout,
      stderr: fdResult.stderr,
      exitCode: fdResult.exitCode,
    }).toEqual({
      stdout: "outer\nfd:10\ninner\n",
      stderr: "",
      exitCode: 0,
    });

    const fs = new InMemoryFs({ "/f": "old\n" });
    const noclobberResult = await toText(
      await new Bash({ fs, cwd: "/" }).exec(
        "set -C; for i in 1; do echo new; done > f; echo after; cat f",
      ),
    );
    expect({
      file: await fs.readFileText("/f"),
      stdout: noclobberResult.stdout,
      stderr: noclobberResult.stderr,
      exitCode: noclobberResult.exitCode,
    }).toEqual({
      file: "old\n",
      stdout: "after\nold\n",
      stderr: "bash: f: cannot overwrite existing file\n",
      exitCode: 0,
    });
  });

  it("redirects a compound construct through an earlier fd variable", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec(
        ': {fd}>f; for i in 1 2; do echo "$i"; done >&$fd; cat f',
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "1\n2\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("reports compound writes to /dev/full once", async () => {
    for (const script of [
      "for i in 1; do echo value; done > /dev/full",
      "if echo value; then :; fi > /dev/full",
    ]) {
      const result = await toText(await new Bash().exec(script));
      expect({
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      }).toEqual({
        stdout: "",
        stderr: "bash: echo: write error: No space left on device\n",
        exitCode: 1,
      });
    }
  });

  it("pipes a converted loop into another command", async () => {
    const result = await toText(
      await new Bash().exec("for i in 1 2 3; do echo $i; done | tr 1-3 a-c"),
    );
    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "a\nb\nc\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("preserves regular and pipe-merged stderr from a converted stage", async () => {
    const regular = await toText(
      await new Bash().exec(
        "for i in 1 2; do echo out$i; echo err$i >&2; done | cat",
      ),
    );
    expect({
      stdout: regular.stdout,
      stderr: regular.stderr,
      exitCode: regular.exitCode,
    }).toEqual({
      stdout: "out1\nout2\n",
      stderr: "err1\nerr2\n",
      exitCode: 0,
    });

    const merged = await toText(
      await new Bash().exec(
        "for i in 1 2; do echo out$i; echo err$i >&2; done |& cat",
      ),
    );
    expect({
      stdout: merged.stdout,
      stderr: merged.stderr,
      exitCode: merged.exitCode,
    }).toEqual({
      stdout: "err1\nerr2\nout1\nout2\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps loop pipeline producers fully buffered before head runs", async () => {
    let marks = 0;
    const bash = new Bash({
      customCommands: [
        defineCommand("mark", async () => {
          marks++;
          return { stdout: "", stderr: "", exitCode: 0 };
        }),
      ],
    });

    const result = await toText(
      await bash.exec("for i in 1 2 3; do echo $i; mark; done | head -1"),
    );
    expect({
      marks,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      marks: 3,
      stdout: "1\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("keeps converted constructs inside legacy redirection boundaries", async () => {
    const bash = new Bash({
      cwd: "/",
      files: {
        "/sourced": "echo source-before; for i in 1; do echo source-loop; done",
      },
    });
    const result = await toText(
      await bash.exec(`
        f() { echo function-before; for i in 1; do echo function-loop; done; }
        { echo group-before; for i in 1; do echo group-loop; done; } > group
        (echo subshell-before; for i in 1; do echo subshell-loop; done) > subshell
        f > function
        eval 'echo eval-before; for i in 1; do echo eval-loop; done' > evaluated
        source sourced > source
        cat group subshell function evaluated source
      `),
    );
    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout:
        "group-before\n" +
        "group-loop\n" +
        "subshell-before\n" +
        "subshell-loop\n" +
        "function-before\n" +
        "function-loop\n" +
        "eval-before\n" +
        "eval-loop\n" +
        "source-before\n" +
        "source-loop\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
