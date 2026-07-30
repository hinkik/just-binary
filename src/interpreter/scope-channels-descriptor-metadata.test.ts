import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { toText } from "../test-utils.js";

describe("scope channel descriptor metadata", () => {
  it("treats writable <& duplicates as channels and rejects ambiguous input", async () => {
    const result = await toText(
      await new Bash({ cwd: "/" }).exec(`
        { echo group >&3; } 3<&1
        (echo subshell >&3) 3<&1
        f() { echo function >&3; } 3<&1
        f
        { echo never; } <&word
        printf 'status:%s\\n' "$?"
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      stdout: "group\nsubshell\nfunction\nstatus:1\n",
      stderr: "bash: word: ambiguous redirect\n",
      exitCode: 0,
    });
  });

  it("allocates mixed brace fds left to right and expands input targets once", async () => {
    const bash = new Bash({ cwd: "/", files: { "/input": "data\n" } });
    const result = await toText(
      await bash.exec(`
        : {out}> /out {in}< /input
        printf 'fds:%s,%s\\n' "$out" "$in"
        echo routed >&$out
        cat <&$in
        cat /out

        : {src}<<<payload
        i=$src
        : {copy}<&$((i++))
        printf 'i:%s\\n' "$i"
        cat <&$copy

        i=3
        { : 0<&$((i++)); printf 'once:%s\\n' "$i"; } 3> /unused
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/out"),
    }).toEqual({
      stdout: "fds:10,11\ndata\nrouted\ni:13\npayload\nonce:4\n",
      stderr: "",
      exitCode: 0,
      file: "routed\n",
    });
  });

  it("preserves temporary fd metadata while replacing a pipeline collector", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        : {base}> /old
        {
          {
            : {copy}>&10
            echo routed 10> /other >&$copy
          } | cat
        } 10> /new
        cat /old /new /other
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      old: await bash.fs.readFileText("/old"),
      new: await bash.fs.readFileText("/new"),
      other: await bash.fs.readFileText("/other"),
    }).toEqual({
      stdout: "routed\n",
      stderr: "",
      exitCode: 0,
      old: "",
      new: "routed\n",
      other: "",
    });
  });

  it("invalidates inherited fd1 metadata for substitution capture", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        {
          value=$(: {copy}>&1; echo captured >&$copy)
          printf 'value=<%s>\\n' "$value"
        } > /outer
        cat /outer
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/outer"),
    }).toEqual({
      stdout: "value=<captured>\n",
      stderr: "",
      exitCode: 0,
      file: "value=<captured>\n",
    });
  });

  it("persists brace-fd source moves inside the owning channel scope", async () => {
    const bash = new Bash({ cwd: "/" });
    const result = await toText(
      await bash.exec(`
        {
          { : {outputCopy}>&3-; } > /nested-other
          echo output >&$outputCopy
          echo should-fail >&3
        } 3> /output-move

        : {inputSource}<<<input
        : {inputCopy}<&$inputSource-
        cat <&$inputCopy
        cat <&$inputSource

        move_in_function() {
          : {functionCopy}>&4-
        } > /function-other
        {
          move_in_function
          echo function >&$functionCopy
          echo should-fail >&4
        } 4> /function-move

        cat /output-move /function-move
      `),
    );

    expect({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      file: await bash.fs.readFileText("/output-move"),
    }).toEqual({
      stdout: "input\noutput\nfunction\n",
      stderr:
        "bash: 3: Bad file descriptor\nbash: 11: Bad file descriptor\nbash: 4: Bad file descriptor\n",
      exitCode: 0,
      file: "output\n",
    });
  });
});
