import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { toText } from "../test-utils.js";

describe("persistent exec and leaf redirection diagnostics", () => {
  it("persists stdout redirection across following statements", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        exec 3>&1
        exec >out
        echo a
        echo b
        cat out >&3
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      out: await bash.fs.readFileText("/out"),
    }).toEqual({
      stdout: "a\nb\n",
      stderr: "",
      exitCode: 0,
      out: "a\nb\n",
    });
  });

  it("persistently duplicates stderr onto stdout", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec("exec 2>&1; echo e >&2"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "e\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("persistently duplicates stdout onto a nonstandard fd", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec("exec 3>&1; echo x >&3"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "x\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("rolls back persistent channels when a later input redirect fails", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(
        "exec 3>&1; exec >out <missing; echo after; printf 'file:<'; cat out; printf '>\\n'",
      ),
    );
    const outExists = await bash.fs.exists("/out");

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      out: outExists ? await bash.fs.readFileText("/out") : "<missing>",
    }).toEqual({
      stdout: "after\nfile:<>\n",
      stderr: "bash: missing: No such file or directory\n",
      exitCode: 0,
      out: "",
    });
  });

  it("reports a persistently closed fd before later redirections", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(await bash.exec("exec 3>&-; echo y >&3 2>err"));

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      errExists: await bash.fs.exists("/err"),
    }).toEqual({
      stdout: "",
      stderr: "bash: 3: Bad file descriptor\n",
      exitCode: 1,
      errExists: false,
    });
  });

  it("isolates persistent exec redirection inside a subshell", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec("(exec >sub; echo child); echo parent; cat sub"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      sub: await bash.fs.readFileText("/sub"),
    }).toEqual({
      stdout: "parent\nchild\n",
      stderr: "",
      exitCode: 0,
      sub: "child\n",
    });
  });

  it("does not leak a nonstandard persistent fd out of a subshell", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec("(exec 3>&1); echo x >&3"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "",
      stderr: "bash: 3: Bad file descriptor\n",
      exitCode: 1,
    });
  });

  it("does not leak persistent fd metadata out of command substitution", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec("x=$(exec 3>&1); echo y >&3 2>err"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      errExists: await bash.fs.exists("/err"),
    }).toEqual({
      stdout: "",
      stderr: "bash: 3: Bad file descriptor\n",
      exitCode: 1,
      errExists: false,
    });
  });

  it("does not advance the parent fd allocator in command substitution", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec(
        'x=$(exec {inner}>&1; exec {inner}>&-); exec {outer}>&1; printf "%s %s\\n" "$outer" "${inner-unset}"',
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "10 unset\n",
      stderr: "",
      exitCode: 0,
    });
  });

  it("lets persistent exec redirection escape a brace group", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(
        "exec 3>&1; { exec >group; echo inner; }; echo outer; cat group >&3",
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      group: await bash.fs.readFileText("/group"),
    }).toEqual({
      stdout: "inner\nouter\n",
      stderr: "",
      exitCode: 0,
      group: "inner\nouter\n",
    });
  });

  it("reports a /dev/full write failure exactly once", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec("echo value >/dev/full"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "",
      stderr: "bash: echo: write error: No space left on device\n",
      exitCode: 1,
    });
  });

  it("reports an ambiguous redirect exactly once without creating a file", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec("target='one two'; echo value >$target"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      targetExists: await bash.fs.exists("/one two"),
    }).toEqual({
      stdout: "",
      stderr: "bash: $target: ambiguous redirect\n",
      exitCode: 1,
      targetExists: false,
    });
  });

  it("reports a command write to closed stdout exactly once", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec("echo value >&-"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "",
      stderr: "bash: echo: write error: Bad file descriptor\n",
      exitCode: 1,
    });
  });

  it("reports noclobber once and preserves the existing file", async () => {
    const fs = new InMemoryFs({ "/out": "old\n" });
    const result = await toText(
      await new Bash({ fs, cwd: "/" }).exec("set -C; echo new >out"),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      out: await fs.readFileText("/out"),
    }).toEqual({
      stdout: "",
      stderr: "bash: out: cannot overwrite existing file\n",
      exitCode: 1,
      out: "old\n",
    });
  });
});
