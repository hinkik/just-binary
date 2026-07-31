import { afterEach, beforeEach, describe, it } from "vitest";
import {
  cleanupTestDir,
  compareOutputs,
  createTestDir,
  setupFiles,
} from "./fixture-runner.js";

describe("temp env bindings - Real Bash Comparison", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  describe("restoration after the command", () => {
    it("should restore after a normal command", async () => {
      const env = await setupFiles(testDir, {});
      await compareOutputs(env, testDir, 'FOO=bar true; echo "[$FOO]"');
    });

    it("should restore when the command is break", async () => {
      const env = await setupFiles(testDir, {});
      await compareOutputs(
        env,
        testDir,
        'for i in 1; do FOO=bar break; done; echo "[$FOO]"',
        { compareStderr: true },
      );
    });

    it("should restore when the command is continue", async () => {
      const env = await setupFiles(testDir, {});
      await compareOutputs(
        env,
        testDir,
        'for i in 1 2; do FOO=bar continue; done; echo "[$FOO]"',
        { compareStderr: true },
      );
    });

    it("should restore a previous value on break", async () => {
      const env = await setupFiles(testDir, {});
      await compareOutputs(
        env,
        testDir,
        'FOO=old; for i in 1; do FOO=new break; done; echo "[$FOO]"',
        { compareStderr: true },
      );
    });
  });
});
