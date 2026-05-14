import type { IFileSystem } from "./fs/interface.js";
import type { ExecutionLimits } from "./limits.js";
import type { SecureFetch } from "./network/index.js";
import type { ByteStream } from "./utils/stream.js";

/**
 * Lightweight interface for feature coverage tracking during fuzzing.
 * Lives here to avoid circular dependencies between fuzzing → core modules.
 */
export interface FeatureCoverageWriter {
  hit(feature: string): void;
}

/**
 * Result of executing a command or script.
 *
 * stdout/stderr are streams of byte chunks. Consumers that need the full
 * content should call collectBytes() / collectText() from utils/stream.ts.
 * Storage is chunked internally — there is no single-Uint8Array size cap.
 */
export interface ExecResult {
  stdout: ByteStream;
  stderr: ByteStream;
  exitCode: number;
  /** The final environment variables after execution (only set by BashEnv.exec) */
  env?: Record<string, string>;
}

/** Result from BashEnv.exec() - always includes env */
export interface BashExecResult extends ExecResult {
  env: Record<string, string>;
}

/** Options for exec calls within commands (internal API) */
export interface CommandExecOptions {
  env?: Record<string, string>;
  cwd: string;
  /** Standard input as a byte stream. Optional — defaults to an empty stream. */
  stdin?: ByteStream;
}

export interface TraceEvent {
  category: string;
  name: string;
  durationMs: number;
  details?: Record<string, unknown>;
}

export type TraceCallback = (event: TraceEvent) => void;

/**
 * Context provided to commands during execution.
 */
export interface CommandContext {
  fs: IFileSystem;
  cwd: string;
  /** Environment variables - uses Map to prevent prototype pollution */
  env: Map<string, Uint8Array>;
  exportedEnv?: Record<string, string>;
  /**
   * Standard input as a byte stream. Commands that need the full input in
   * memory should call collectBytes(ctx.stdin) once. Streaming commands
   * (cat, grep, head, tee, wc) can consume chunks incrementally.
   */
  stdin: ByteStream;
  limits?: Required<ExecutionLimits>;
  trace?: TraceCallback;
  exec?: (command: string, options: CommandExecOptions) => Promise<ExecResult>;
  fetch?: SecureFetch;
  getRegisteredCommands?: () => string[];
  sleep?: (ms: number) => Promise<void>;
  fileDescriptors?: Map<number, string>;
  xpgEcho?: boolean;
  substitutionDepth?: number;
  coverage?: FeatureCoverageWriter;
}

export interface Command {
  name: string;
  execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult>;
}

export type CommandRegistry = Map<string, Command>;

// Re-export for convenience
export type { IFileSystem };
export type { ByteStream };
