import type { ExecResult } from "./types.js";
import { decode } from "./utils/bytes.js";

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
 * Convert an ExecResult (with Uint8Array stdout/stderr) to text strings.
 * Use this in tests for easy string comparison.
 */
export function toText(result: ExecResult): TextResult {
  return {
    stdout: decode(result.stdout),
    stderr: decode(result.stderr),
    exitCode: result.exitCode,
    ...(result.env ? { env: result.env } : {}),
  };
}
