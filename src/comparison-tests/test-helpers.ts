import { BashEnv } from '../BashEnv.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

export const execAsync = promisify(exec);

/**
 * Creates a unique temp directory for testing
 */
export async function createTestDir(): Promise<string> {
  const testDir = path.join(
    os.tmpdir(),
    `bashenv-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  await fs.mkdir(testDir, { recursive: true });
  return testDir;
}

/**
 * Cleans up the temp directory
 */
export async function cleanupTestDir(testDir: string): Promise<void> {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Sets up test files in both real FS and creates a BashEnv
 */
export async function setupFiles(
  testDir: string,
  files: Record<string, string>
): Promise<BashEnv> {
  // Create files in real FS
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(testDir, filePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content);
  }

  // Create equivalent BashEnv with normalized paths
  const bashEnvFiles: Record<string, string> = {};
  for (const [filePath, content] of Object.entries(files)) {
    bashEnvFiles[path.join(testDir, filePath)] = content;
  }

  return new BashEnv({
    files: bashEnvFiles,
    cwd: testDir,
  });
}

/**
 * Runs a command in real bash
 */
export async function runRealBash(
  command: string,
  cwd: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, shell: '/bin/bash' });
    return { stdout, stderr, exitCode: 0 };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: err.stdout || '',
      stderr: err.stderr || '',
      exitCode: err.code || 1,
    };
  }
}

/**
 * Compares BashEnv output with real bash output
 */
export async function compareOutputs(
  env: BashEnv,
  testDir: string,
  command: string,
  options?: { compareStderr?: boolean; compareExitCode?: boolean }
): Promise<void> {
  const [bashEnvResult, realBashResult] = await Promise.all([
    env.exec(command),
    runRealBash(command, testDir),
  ]);

  if (bashEnvResult.stdout !== realBashResult.stdout) {
    throw new Error(
      `stdout mismatch for "${command}"\n` +
        `Expected (real bash): ${JSON.stringify(realBashResult.stdout)}\n` +
        `Received (BashEnv):   ${JSON.stringify(bashEnvResult.stdout)}`
    );
  }

  if (options?.compareExitCode !== false) {
    if (bashEnvResult.exitCode !== realBashResult.exitCode) {
      throw new Error(
        `exitCode mismatch for "${command}"\n` +
          `Expected (real bash): ${realBashResult.exitCode}\n` +
          `Received (BashEnv):   ${bashEnvResult.exitCode}`
      );
    }
  }
}

export { path, fs };
