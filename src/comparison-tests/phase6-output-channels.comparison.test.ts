import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("phase 6 output channels - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("disconnects a redirected intermediate stage from the pipe", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "printf 'a\\n' >f | sed 's/^/pipe:/'; printf 'file:<'; cat f; printf '>\\n'",
      { compareStderr: true },
    );
  });

  it("persists exec stdout redirection", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "exec 3>&1; exec >out; echo a; echo b; cat out >&3",
      { compareStderr: true },
    );
  });

  it("persistently duplicates stderr onto stdout", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "exec 2>&1; echo e >&2", {
      compareStderr: true,
    });
  });

  it("persistently duplicates stdout onto fd 3", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "exec 3>&1; echo x >&3", {
      compareStderr: true,
    });
  });

  it("fails before a later redirect when fd 3 is closed", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "{ exec 3>&-; echo y >&3 2>err; status=$?; printf 'status:%s err:' \"$status\"; if [ -e err ]; then cat err; else printf missing; fi; printf '\\n'; } 2>diag; sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #' diag >&2",
      { compareStderr: true },
    );
  });

  it("isolates persistent exec redirection in a subshell", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "(exec >sub; echo child); echo parent; cat sub",
      { compareStderr: true },
    );
  });

  it("isolates persistent exec descriptors in command substitution", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "{ x=$(exec 3>&1); echo y >&3 2>err; status=$?; printf 'status:%s err:' \"$status\"; if [ -e err ]; then cat err; else printf missing; fi; printf '\\n'; } 2>diag; sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #' diag >&2",
      { compareStderr: true },
    );
  });

  it("lets persistent exec redirection escape a brace group", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "exec 3>&1; { exec >group; echo inner; }; echo outer; cat group >&3",
      { compareStderr: true },
    );
  });

  it("writes a command xtrace before installing its stderr redirect", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "set -x; echo hi 2>trace; set +x; printf 'trace:<'; cat trace; printf '>\\n'",
      { compareStderr: true },
    );
  });
});
