import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

const NORMALIZE_ERROR =
  "sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #' error >&2";

describe("redirection source ordering - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  async function compareOrdering(command: string): Promise<void> {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      `{ ${command}; rc=$?; } 2>error; ` +
        "if [ -e made.txt ]; then state=present; else state=absent; fi; " +
        `${NORMALIZE_ERROR}; printf "rc=%s file=%s\\n" "$rc" "$state"`,
      { compareStderr: true },
    );
  }

  it("stops a while after a failing input redirect", async () => {
    await compareOrdering("while read line; do :; done < nofile > made.txt");
  });

  it("creates a while output before a later input redirect fails", async () => {
    await compareOrdering("while read line; do :; done > made.txt < nofile");
  });

  it("stops a simple command after a failing input redirect", async () => {
    await compareOrdering("cat < nofile > made.txt");
  });

  it("creates a simple-command output before a later input redirect fails", async () => {
    await compareOrdering("cat > made.txt < nofile");
  });

  it("stops a group after a failing input redirect", async () => {
    await compareOrdering("{ cat; } < nofile > made.txt");
  });

  it("creates a group output before a later input redirect fails", async () => {
    await compareOrdering("{ cat; } > made.txt < nofile");
  });

  // A directory opens successfully as input in bash; only reading it fails, so
  // the later redirection still takes effect and `made.txt` is created. The
  // diagnostic itself is not compared: bash attributes it to the reader
  // ("cat: stdin: Is a directory") while we report it from the shell, because
  // command provenance is not carried across lazy streams.
  it("applies a later redirect when the input is a directory", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "mkdir dir; { cat < dir > made.txt; } 2>/dev/null; rc=$?; " +
        "if [ -e made.txt ]; then state=present; else state=absent; fi; " +
        'printf "rc=%s file=%s\\n" "$rc" "$state"',
      { compareStderr: true },
    );
  });

  it("routes an input error into an earlier stderr redirect", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "cat 2>error <nofile; rc=$?; " +
        'printf "rc=%s err=<" "$rc"; ' +
        "sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #' error; printf '>\\n'",
      { compareStderr: true },
    );
  });
});
