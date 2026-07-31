import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("compound command redirections - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("redirects input and output around a read-driven while loop", async () => {
    const env = await setupFiles(testDir, {
      "input.txt": "alpha\nbeta\n",
    });
    await compareOutputs(
      env,
      testDir,
      'while read -r line; do echo "got:$line"; done < input.txt > out.txt; cat out.txt',
      { compareStderr: true },
    );
  });

  it("redirects a counted while loop", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "i=0; while [ $i -lt 3 ]; do echo n$i; i=$((i+1)); done > out.txt; cat out.txt",
      { compareStderr: true },
    );
  });

  it("redirects an if construct", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "if true; then echo yes; fi > out.txt; cat out.txt",
      { compareStderr: true },
    );
  });

  it("redirects an until loop", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "until [ -f stop ]; do echo tick; touch stop; done > out.txt; cat out.txt",
      { compareStderr: true },
    );
  });
});
