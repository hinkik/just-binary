import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { toText } from "../test-utils.js";

describe("scope channel file-descriptor lifetimes", () => {
  it("restores a shadowed stdout after moving the temporary binding", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        { : {copy}>&1-; echo inner >&$copy; } > /new
        echo after
        cat /new
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/new"),
    }).toEqual({
      stdout: "after\ninner\n",
      stderr: "",
      exitCode: 0,
      file: "inner\n",
    });
  });

  it("restores a persistent fd hidden by a group redirection", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        : {base}> /old
        { : {copy}>&10-; echo inside >&$copy; } 10> /new
        echo after >&$base
        cat /old /new
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      old: await bash.fs.readFileText("/old"),
      new: await bash.fs.readFileText("/new"),
    }).toEqual({
      stdout: "after\ninside\n",
      stderr: "",
      exitCode: 0,
      old: "after\n",
      new: "inside\n",
    });
  });

  it("allocates brace fds above temporary open descriptors", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        {
          : {allocated}> /allocated
          printf 'fd:%s\\n' "$allocated"
          echo routed >&$allocated
        } 10> /outer
        cat /allocated /outer
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      allocated: await bash.fs.readFileText("/allocated"),
      outer: await bash.fs.readFileText("/outer"),
    }).toEqual({
      stdout: "fd:11\nrouted\n",
      stderr: "",
      exitCode: 0,
      allocated: "routed\n",
      outer: "",
    });
  });

  it("keeps the snapshotted sink of a persistent brace duplicate", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        : {copy}>&1
        f() { echo bypass >&$copy; } > /side
        f
        printf 'side=<'
        cat /side
        printf '>\\n'
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      side: await bash.fs.readFileText("/side"),
    }).toEqual({
      stdout: "bypass\nside=<>\n",
      stderr: "",
      exitCode: 0,
      side: "",
    });
  });

  it("keeps temporary closes visible to nested leaves", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        : {base}> /old
        { echo closed >&$base; } 10>&-
        printf 'status:%s\\n' "$?"
        echo restored >&$base
        cat /old
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      old: await bash.fs.readFileText("/old"),
    }).toEqual({
      stdout: "status:1\nrestored\n",
      stderr: "bash: 10: Bad file descriptor\n",
      exitCode: 0,
      old: "restored\n",
    });
  });

  it("isolates last-stage fd mutations in default pipelines", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        closed=1
        printf x | { : {closed}>&-; }
        echo should-print
        { printf x | { fd=3; : {fd}>&-; }; echo after >&3; } 3> /fd3
        cat /fd3
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      fd3: await bash.fs.readFileText("/fd3"),
    }).toEqual({
      stdout: "should-print\nafter\n",
      stderr: "",
      exitCode: 0,
      fd3: "after\n",
    });
  });

  it("does not move through an already-closed temporary binding", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        : {base}> /old
        x=$base
        { { : {x}>&-; }; } 11>&10-
        echo after >&$base
        cat /old
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      old: await bash.fs.readFileText("/old"),
    }).toEqual({
      stdout: "after\n",
      stderr: "",
      exitCode: 0,
      old: "after\n",
    });
  });

  it("removes normalized append descriptors when closing brace fds", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        : {append}>> /file
        : {append}>&-
        read -u "$append" value
        printf 'status:%s value=<%s>\\n' "$?" "$value"
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/file"),
    }).toEqual({
      stdout: "status:1 value=<>\n",
      stderr: "",
      exitCode: 0,
      file: "",
    });
  });

  it("expands explicit output <& call redirects once", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec(`
        i=2
        f() { echo function; }
        f 1<&$((i++))
        printf 'i=%s\\n' "$i"
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "i=3\n",
      stderr: "function\n",
      exitCode: 0,
    });
  });
});
