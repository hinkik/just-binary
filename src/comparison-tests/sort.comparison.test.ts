import { describe, it, beforeEach, afterEach } from 'vitest';
import { createTestDir, cleanupTestDir, setupFiles, compareOutputs } from './test-helpers.js';

describe('sort command - Real Bash Comparison', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await createTestDir();
  });

  afterEach(async () => {
    await cleanupTestDir(testDir);
  });

  describe('default sorting', () => {
    it('should sort alphabetically', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'banana\napple\ncherry\n',
      });
      await compareOutputs(env, testDir, 'sort test.txt');
    });

    it('should sort with mixed case', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'Banana\napple\nCherry\nbanana\n',
      });
      await compareOutputs(env, testDir, 'sort test.txt');
    });

    it('should handle empty lines', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'b\n\na\n\nc\n',
      });
      await compareOutputs(env, testDir, 'sort test.txt');
    });
  });

  describe('-r flag (reverse)', () => {
    it('should sort in reverse', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'banana\napple\ncherry\n',
      });
      await compareOutputs(env, testDir, 'sort -r test.txt');
    });
  });

  describe('-n flag (numeric)', () => {
    it('should sort numerically', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': '10\n2\n1\n20\n5\n',
      });
      await compareOutputs(env, testDir, 'sort -n test.txt');
    });

    it('should sort negative numbers', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': '10\n-5\n0\n-10\n5\n',
      });
      await compareOutputs(env, testDir, 'sort -n test.txt');
    });

    it('should handle mixed numbers and text', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': '10 apples\n2 oranges\n5 bananas\n',
      });
      await compareOutputs(env, testDir, 'sort -n test.txt');
    });
  });

  describe('-u flag (unique)', () => {
    it('should remove duplicates', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'apple\nbanana\napple\ncherry\nbanana\n',
      });
      await compareOutputs(env, testDir, 'sort -u test.txt');
    });

    it('should combine -n and -u', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': '5\n3\n5\n1\n3\n',
      });
      await compareOutputs(env, testDir, 'sort -nu test.txt');
    });
  });

  describe('-k flag (key field)', () => {
    it('should sort by second field', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'x 3\ny 1\nz 2\n',
      });
      await compareOutputs(env, testDir, 'sort -k 2 test.txt');
    });

    it('should sort numerically by key', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'x 10\ny 2\nz 5\n',
      });
      await compareOutputs(env, testDir, 'sort -k 2 -n test.txt');
    });
  });

  describe('-t flag (delimiter)', () => {
    it('should use custom delimiter', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'a:3\nb:1\nc:2\n',
      });
      await compareOutputs(env, testDir, 'sort -t: -k2 test.txt');
    });

    it('should sort numerically with delimiter', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'a:10\nb:2\nc:5\n',
      });
      await compareOutputs(env, testDir, 'sort -t: -k2 -n test.txt');
    });

    it('should reverse sort with delimiter', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'a:1\nb:3\nc:2\n',
      });
      await compareOutputs(env, testDir, 'sort -t: -k2 -rn test.txt');
    });
  });

  describe('stdin', () => {
    it('should sort stdin', async () => {
      const env = await setupFiles(testDir, {});
      await compareOutputs(env, testDir, 'echo -e "c\\na\\nb" | sort');
    });
  });

  describe('combined flags', () => {
    it('should combine -n and -r', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': '10\n2\n1\n20\n',
      });
      await compareOutputs(env, testDir, 'sort -nr test.txt');
    });

    it('should combine -r and -u', async () => {
      const env = await setupFiles(testDir, {
        'test.txt': 'apple\nbanana\napple\ncherry\n',
      });
      await compareOutputs(env, testDir, 'sort -ru test.txt');
    });
  });
});
