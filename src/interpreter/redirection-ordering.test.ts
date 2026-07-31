import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { type TextResult, toText } from "../test-utils.js";

function expectResult(
  result: TextResult,
  expected: { stdout: string; stderr: string; exitCode: number },
): void {
  expect({
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  }).toEqual(expected);
}

describe("redirection source ordering", () => {
  it("regression: does not create a later output file after while input redirection fails", async () => {
    const result = await toText(
      await new Bash().exec(
        "while read line; do :; done < nofile > made.txt; " +
          'rc=$?; if [ -e made.txt ]; then state=present; else state=absent; fi; printf "rc=%s file=%s\\n" "$rc" "$state"',
      ),
    );

    expectResult(result, {
      stdout: "rc=1 file=absent\n",
      stderr: "bash: nofile: No such file or directory\n",
      exitCode: 0,
    });
  });

  it("creates an earlier while output file before a later input redirection fails", async () => {
    const result = await toText(
      await new Bash().exec(
        "while read line; do :; done > made.txt < nofile; " +
          'rc=$?; if [ -e made.txt ]; then state=present; else state=absent; fi; printf "rc=%s file=%s\\n" "$rc" "$state"',
      ),
    );

    expectResult(result, {
      stdout: "rc=1 file=present\n",
      stderr: "bash: nofile: No such file or directory\n",
      exitCode: 0,
    });
  });

  it("applies simple-command redirections left to right", async () => {
    const result = await toText(
      await new Bash().exec(
        "cat < nofile > first.txt; first_rc=$?; " +
          "cat > second.txt < nofile; second_rc=$?; " +
          'for file in first.txt second.txt; do if [ -e "$file" ]; then printf "%s=present\\n" "$file"; else printf "%s=absent\\n" "$file"; fi; done; ' +
          'printf "rcs=%s,%s\\n" "$first_rc" "$second_rc"',
      ),
    );

    expectResult(result, {
      stdout: "first.txt=absent\nsecond.txt=present\nrcs=1,1\n",
      stderr:
        "bash: nofile: No such file or directory\n" +
        "bash: nofile: No such file or directory\n",
      exitCode: 0,
    });
  });

  it("applies brace-group redirections left to right", async () => {
    const result = await toText(
      await new Bash().exec(
        "{ cat; } < nofile > first.txt; first_rc=$?; " +
          "{ cat; } > second.txt < nofile; second_rc=$?; " +
          'for file in first.txt second.txt; do if [ -e "$file" ]; then printf "%s=present\\n" "$file"; else printf "%s=absent\\n" "$file"; fi; done; ' +
          'printf "rcs=%s,%s\\n" "$first_rc" "$second_rc"',
      ),
    );

    expectResult(result, {
      stdout: "first.txt=absent\nsecond.txt=present\nrcs=1,1\n",
      stderr:
        "bash: nofile: No such file or directory\n" +
        "bash: nofile: No such file or directory\n",
      exitCode: 0,
    });
  });

  it("routes a later input-redirection diagnostic through an earlier stderr redirection", async () => {
    const result = await toText(
      await new Bash().exec(
        "cat 2> err.txt < nofile; rc=$?; " +
          'printf "rc=%s err=<" "$rc"; cat err.txt; printf ">\\n"',
      ),
    );

    expectResult(result, {
      stdout: "rc=1 err=<bash: nofile: No such file or directory\n>\n",
      stderr: "",
      exitCode: 0,
    });
  });
});
