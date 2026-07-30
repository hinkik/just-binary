import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { toText } from "../test-utils.js";
import { decode } from "../utils/bytes.js";

describe("scope channel file-descriptor redirections", () => {
  it("exposes temporary nonstandard fds to nested legacy leaves", async () => {
    let observedStdout = "";
    let observedStderr = "";
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(
        `
          { echo group >&3; } 3> /group-fd
          (echo subshell >&3) 3> /subshell-fd
          f() { echo definition >&3; } 3> /definition-fd
          f
          g() { echo call-site >&3; }
          g 3> /call-fd
          { : {copy}>&3; echo copied >&$copy; } 3> /copied-fd
          { : {persistent}>&3; } 3> /persistent-fd
          echo persistent >&$persistent
          { echo later-stderr >&3 1>&2; } 3> /overridden-fd
          { echo later-file 1>&2 >&3; } 3> /winning-fd
          cat /group-fd /subshell-fd /definition-fd /call-fd /copied-fd /persistent-fd /overridden-fd /winning-fd
        `,
        {
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
      observedStdout:
        "group\nsubshell\ndefinition\ncall-site\ncopied\npersistent\nlater-file\n",
      observedStderr: "later-stderr\n",
      stdout:
        "group\nsubshell\ndefinition\ncall-site\ncopied\npersistent\nlater-file\n",
      stderr: "later-stderr\n",
      exitCode: 0,
    });
  });

  it("rejects a nonnumeric <& target before executing the body", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(await bash.exec("{ echo never; } 1<&word"));
    let targetExists = true;
    try {
      await bash.fs.stat("/word");
    } catch {
      targetExists = false;
    }

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      targetExists,
    }).toEqual({
      stdout: "",
      stderr: "bash: word: ambiguous redirect\n",
      exitCode: 1,
      targetExists: false,
    });
  });

  it("opens inherited-fd leaf redirects before command side effects", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        { mkdir /made 1<&word; [[ -d /made ]] && echo exists >&3; } 3> /out
      `),
    );
    let madeExists = true;
    try {
      await bash.fs.stat("/made");
    } catch {
      madeExists = false;
    }

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      madeExists,
      out: await bash.fs.readFileText("/out"),
    }).toEqual({
      stdout: "",
      stderr: "bash: word: ambiguous redirect\n",
      exitCode: 1,
      madeExists: false,
      out: "",
    });
  });

  it("keeps inherited-fd write errors inside the leaf stderr redirect", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(
        "{ echo hi > /dev/full 2> /write-error; } 3> /unused; cat /write-error",
      ),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/write-error"),
    }).toEqual({
      stdout: "bash: echo: write error: No space left on device\n",
      stderr: "",
      exitCode: 0,
      file: "bash: echo: write error: No space left on device\n",
    });
  });

  it("keeps brace-fd binding, lifetime, close, and expansion ordering", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        : > /ordered {ordered}>&1
        echo ordered >&$ordered

        { : {append}>&3; } 3>> /append
        echo append >&$append

        : {closed}> /closed
        { : {closed}>&-; } > /ignored
        echo should-fail >&$closed

        i=1
        : {once}>&$((i++))
        echo i:$i

        { : {bad}>&4; } 3> /unused
        echo done
        cat /ordered /append /closed
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      ordered: await bash.fs.readFileText("/ordered"),
      append: await bash.fs.readFileText("/append"),
      closed: await bash.fs.readFileText("/closed"),
      ignored: await bash.fs.readFileText("/ignored"),
      unused: await bash.fs.readFileText("/unused"),
    }).toEqual({
      stdout: "i:2\ndone\nordered\nappend\n",
      stderr: "bash: 12: Bad file descriptor\nbash: 4: Bad file descriptor\n",
      exitCode: 0,
      ordered: "ordered\n",
      append: "append\n",
      closed: "",
      ignored: "",
      unused: "",
    });
  });

  it("expands function-definition redirects at call time before the body", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        i=0
        f() { printf 'body:%s\\n' "$i"; } > "/definition-$((i++))"
        i=4
        f > /call
        printf 'i:%s\\n' "$i"
      `),
    );
    let definitionTimeFileExists = true;
    try {
      await bash.fs.stat("/definition-0");
    } catch {
      definitionTimeFileExists = false;
    }

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      definitionTimeFileExists,
      definition: await bash.fs.readFileText("/definition-4"),
      call: await bash.fs.readFileText("/call"),
    }).toEqual({
      stdout: "i:5\n",
      stderr: "",
      exitCode: 0,
      definitionTimeFileExists: false,
      definition: "body:5\n",
      call: "",
    });
  });

  it("clones temporary descriptor metadata into an isolated subshell", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        {
          (
            : {copy}>&3
            echo copied >&$copy
          )
        } 3> /subshell-copy
        [[ -z \${copy+x} ]] && echo isolated
        cat /subshell-copy
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/subshell-copy"),
    }).toEqual({
      stdout: "isolated\ncopied\n",
      stderr: "",
      exitCode: 0,
      file: "copied\n",
    });
  });

  it("lets a subshell snapshot a temporary fd over stale persistent metadata", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        : {base}> /old
        {
          (
            : {copy}>&10
            echo copied >&$copy
          )
        } 10> /new
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
      stdout: "copied\n",
      stderr: "",
      exitCode: 0,
      old: "",
      new: "copied\n",
    });
  });
});
