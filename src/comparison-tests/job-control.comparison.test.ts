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
    await compareOutputs(
      env,
      testDir,
      "sleep 0.01 & wait; sleep 5 & jobs; kill %1",
      {
        compareStderr: true,
      },
    );
  });

  // A non-interactive bash reaps a completed child as it notices it, so no later
  // command can see the finished job — not `jobs`, and not a `%1` spec.
  it("does not list or resolve a completed job", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      'false & sleep 0.05; jobs; printf "jobs:%s\\n" "$?"; ' +
        'jobs %1 2>err; printf "spec:%s\\n" "$?"; ' +
        "sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #' err >&2",
      { compareStderr: true },
    );
  });

  // `wait` waits for the shell's own children. A subshell is a fork, so a job it
  // starts belongs to it, and the parent's `wait` must return without it. Probed
  // through a marker file rather than wall-clock time.
  it("does not wait for a job started inside a subshell", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "( { sleep 0.3; echo late > marker; } & ); wait; echo waited; " +
        "[ -e marker ] && echo marker-exists || echo marker-absent",
      { compareStderr: true },
    );
  });

  // Signal 0 sends nothing and only asks whether the target exists, and `kill`
  // succeeds when it signalled at least one target.
  it("supports the signal-0 existence probe and partial success", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      'sleep 5 & p=$!; kill -0 "$p"; printf "live:%s\\n" "$?"; ' +
        'kill "$p" 999999 2>err; printf "some:%s\\n" "$?"; ' +
        'kill -l ABRT; wait "$p" 2>/dev/null; ' +
        "sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #' err >&2",
      { compareStderr: true },
    );
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
