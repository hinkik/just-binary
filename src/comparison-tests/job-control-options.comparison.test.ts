import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("job control options - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  async function compare(script: string): Promise<void> {
    const env = await setupFiles(testDir, {});
    await compareOutputs(env, testDir, script, { compareStderr: true });
  }

  it("delivers HUP by name", async () => {
    await compare(
      "sleep 9 & kill -HUP $!; wait $! 2>/dev/null; printf 'status:%s\\n' $?",
    );
  });

  it("delivers KILL by name", async () => {
    await compare(
      "sleep 9 & kill -KILL $!; wait $! 2>/dev/null; printf 'status:%s\\n' $?",
    );
  });

  it("delivers KILL by number", async () => {
    await compare(
      "sleep 9 & kill -9 $!; wait $! 2>/dev/null; printf 'status:%s\\n' $?",
    );
  });

  it("delivers TERM with -s", async () => {
    await compare(
      "sleep 9 & kill -s TERM $!; wait $! 2>/dev/null; printf 'status:%s\\n' $?",
    );
  });

  it("accepts STOP and CONT", async () => {
    await compare(
      "sleep 9 & p=$!; kill -STOP $p; a=$?; kill -CONT $p; b=$?; " +
        "kill -KILL $p; wait $p 2>/dev/null; " +
        "printf 'stop:%s cont:%s wait:%s\\n' $a $b $?",
    );
  });

  it("reports an invalid signal", async () => {
    await compare(
      "kill -BOGUS 999999 2>error; rc=$?; " +
        "sed -E 's#^/bin/bash: (line [0-9]+: )?#bash: #' error >&2; " +
        'printf "status:%s\\n" "$rc"',
    );
  });

  it("lists signal names and numbers", async () => {
    await compare(
      'printf "term=%s nine=%s\\n" "$(kill -l TERM)" "$(kill -l 9)"',
    );
  });

  it("uses jobs -p for the canonical kill jobs idiom", async () => {
    await compare(
      'sleep 9 & p=$!; [ "$(jobs -p)" = "$p" ] && echo matched; ' +
        "kill $(jobs -p); wait $p 2>/dev/null; printf 'status:%s\\n' $?",
    );
  });

  it("supports long, running, and stopped job filters", async () => {
    await compare(
      "sleep 9 & p=$!; " +
        "jobs -l | sed -E 's/^(\\[[0-9]+\\][+-]? )[0-9]+ /\\1PID /'; " +
        "jobs -r; printf 'stopped=<'; jobs -s; printf '>\\n'; " +
        "kill $p; wait $p 2>/dev/null",
    );
  });

  it("lists only newly changed jobs with -n", async () => {
    await compare(
      "sleep 9 & p=$!; jobs -n; printf 'again=<'; jobs -n; printf '>\\n'; " +
        "kill $p; wait $p 2>/dev/null",
    );
  });

  it("substitutes a jobspec with jobs -x", async () => {
    await compare(
      "sleep 9 & p=$!; jobs -x printf 'pid-set:%s\\n' %1 | " +
        "sed -E 's/[0-9]+/yes/'; kill $p; wait $p 2>/dev/null",
    );
  });
});
