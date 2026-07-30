/**
 * Browser-compatible entry point for just-bash.
 *
 * Excludes Node.js-specific modules:
 * - OverlayFs (requires node:fs)
 * - ReadWriteFs (requires node:fs)
 * - Sandbox (uses OverlayFs)
 *
 * Note: The gzip/gunzip/zcat commands will fail at runtime in browsers
 * since they use node:zlib. All other commands work.
 */

export type { BashLogger, BashOptions, ExecOptions } from "./Bash.js";
export { Bash } from "./Bash.js";
export type {
  AllCommandName,
  CommandName,
  NetworkCommandName,
} from "./commands/registry.js";
export {
  getCommandNames,
  getNetworkCommandNames,
} from "./commands/registry.js";
export type {
  CustomCommand,
  CustomExecResult,
  LazyCommand,
  StringExecResult,
} from "./custom-commands.js";
export { defineCommand } from "./custom-commands.js";
export { InMemoryFs } from "./fs/in-memory-fs/index.js";
export type {
  BufferEncoding,
  CpOptions,
  DirectoryEntry,
  FileContent,
  FileEntry,
  FileInit,
  FileSystemFactory,
  FsEntry,
  FsStat,
  InitialFiles,
  MkdirOptions,
  RmOptions,
  SymlinkEntry,
} from "./fs/interface.js";
// FS classes that work in the browser (no node:fs).
export {
  MountableFs,
  type MountableFsOptions,
  type MountConfig,
} from "./fs/mountable-fs/index.js";
export {
  AbortExecutionError,
  checkAborted,
} from "./interpreter/errors.js";
export type { OutputSink } from "./interpreter/output-channels.js";
export type { NetworkConfig } from "./network/index.js";
export {
  NetworkAccessDeniedError,
  RedirectNotAllowedError,
  TooManyRedirectsError,
} from "./network/index.js";
export type {
  JobInfo,
  JobRunner,
  JobSignal,
  ListedJob,
  ProcessTableOptions,
} from "./process/process-table.js";
export { ProcessTable } from "./process/process-table.js";
export type {
  BashExecResult,
  Command,
  CommandContext,
  ExecResult,
  IFileSystem,
} from "./types.js";
// Byte helpers exposed alongside streams for parity with the Node entry.
export { decode, EMPTY, encode } from "./utils/bytes.js";
// Stream utilities — the public surface from utils/stream.ts. Without
// these, browser consumers cannot read the ByteStream returned by
// stdout/stderr/stdin/fs.readFile.
export type { ByteStream } from "./utils/stream.js";
export {
  CHUNK_SIZE,
  collectBytes,
  collectText,
  concatStreams,
  drain,
  emptyStream,
  fromBytes,
  fromChunks,
  fromString,
  mapChunks,
  streamChunks,
  streamLines,
  teeStream,
} from "./utils/stream.js";
