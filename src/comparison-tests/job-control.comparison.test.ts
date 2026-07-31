import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("job control - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("waits for a background command and preserves its output", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "echo hi & wait", {
      compareStderr: true,
    });
  });

  it("lists a running background job", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "sleep 0.1 & jobs", {
      compareStderr: true,
    });
  });

  it("returns a terminated background job's status from wait", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "sleep 5 & kill $!; wait $! 2>/dev/null; echo $?",
      { compareStderr: true },
    );
  });

  it("sets the last background PID", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      'sleep 0.1 & [ "$!" -gt 0 ] && echo set; wait',
      { compareStderr: true },
    );
  });

  it("successfully waits when there are no jobs", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "wait", {
      compareStderr: true,
    });
  });

  it("rejects an unknown PID", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "kill 99999999 2>err; status=$?; sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #' err >&2; exit \"$status\"",
      { compareStderr: true },
    );
  });

  it("does not announce jobs in a non-interactive shell", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "true & wait", {
      compareStderr: true,
    });
  });

  it("keeps jobs empty after wait-all reaps a completed job", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "sleep 0.05 & wait; jobs; jobs", {
      compareStderr: true,
    });
  });

  it("recycles the job number after wait-all drains the table", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, "sleep 0.01 & wait; sleep 0.01 & jobs", {
      compareStderr: true,
    });
  });

  it("retains a finished job's status for targeted wait", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      'false & pid=$!; sleep 0.01; wait "$pid"; printf "status:%s\\n" "$?"',
      { compareStderr: true },
    );
  });

  it("forgets a completed PID after wait-all", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      'false & pid=$!; wait; wait "$pid" 2>err; status=$?; ' +
        "sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #; " +
        "s#pid [0-9]+#pid PID#' err >&2; " +
        'printf "status:%s\\n" "$status"',
      { compareStderr: true },
    );
  });
});
