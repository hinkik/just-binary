import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("sequencing channels - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  it("preserves nested break and continue output", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      'for o in 1 2; do echo o$o; for i in 1 2; do echo i$o:$i; [ "$i" = 1 ] && continue; break 2; done; echo after; done; echo done',
    );
  });

  it("preserves failed condition and case output", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "if echo first; false; then echo no; elif echo second; true; then case foo in f*) echo match; echo case-error >&2;; esac; fi",
    );
  });

  it("captures loop stdout while forwarding loop stderr", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      'out=$(for i in 1 2; do echo $i; echo e$i >&2; done); echo "got:$out"',
    );
  });

  it("pipes a loop through a consumer", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "for i in 1 2 3; do echo $i; done | tr 1-3 a-c",
    );
  });

  it("applies compound append redirections", async () => {
    const env = await setupFiles(testDir, {});
    await compareOutputs(
      env,
      testDir,
      "for i in 1 2; do echo append$i; done >> out; cat out",
    );
  });
});
