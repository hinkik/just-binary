import type { ExecResult } from "./types.js";
import { collectText } from "./utils/stream.js";

/**
 * Decoded version of ExecResult for convenient test assertions.
 */
export interface TextResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  env?: Record<string, string>;
}

/**
 * Drain ExecResult streams into decoded text strings for test assertions.
 */
export async function toText(result: ExecResult): Promise<TextResult> {
  const [stdout, stderr] = await Promise.all([
    collectText(result.stdout),
    collectText(result.stderr),
  ]);
  return {
    stdout,
    stderr,
    exitCode: result.exitCode,
    ...(result.env ? { env: result.env } : {}),
  };
}
