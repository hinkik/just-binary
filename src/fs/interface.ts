import type { ByteStream } from "../utils/stream.js";

/**
 * Supported buffer encodings
 */
export type BufferEncoding =
  | "utf8"
  | "utf-8"
  | "ascii"
  | "binary"
  | "base64"
  | "hex"
  | "latin1";

/**
 * Content that can be written to a file. Streams remove the per-allocation
 * size cap; strings and Uint8Arrays are conveniences for small payloads.
 */
export type FileContent = string | Uint8Array | ByteStream;

export interface ReadFileOptions {
  encoding?: BufferEncoding | null;
}

export interface WriteFileOptions {
  encoding?: BufferEncoding;
}

/**
 * In-memory file content is stored as an array of chunks so a single
 * physical Uint8Array allocation never exceeds CHUNK_SIZE.
 */
export interface FileEntry {
  type: "file";
  /** Chunked content. Each chunk is a Uint8Array of up to CHUNK_SIZE bytes. */
  chunks: Uint8Array[];
  /** Total byte length across all chunks. Cached to avoid re-summing. */
  size: number;
  mode: number;
  mtime: Date;
}

export interface DirectoryEntry {
  type: "directory";
  mode: number;
  mtime: Date;
}

export interface SymlinkEntry {
  type: "symlink";
  target: string;
  mode: number;
  mtime: Date;
}

export type FsEntry = FileEntry | DirectoryEntry | SymlinkEntry;

export interface DirentEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

export interface FsStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  mode: number;
  size: number;
  mtime: Date;
}

export interface MkdirOptions {
  recursive?: boolean;
}

export interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}

export interface CpOptions {
  recursive?: boolean;
}

/**
 * Abstract filesystem interface.
 *
 * All I/O is stream-based to remove the per-Uint8Array size cap. Convenience
 * helpers (readFileText/writeFileText) exist for small/text payloads.
 */
export interface IFileSystem {
  /**
   * Open a file for reading. Returns a stream of byte chunks.
   * @throws if path does not exist or is a directory
   */
  readFile(path: string): Promise<ByteStream>;

  /**
   * Read a file fully as decoded text (default encoding: utf8).
   * Convenience for small/text files.
   * @throws if path does not exist or is a directory
   */
  readFileText(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string>;

  /**
   * Write content to a file, creating it if it doesn't exist.
   * Accepts a stream (preferred for large content), Uint8Array, or string.
   */
  writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void>;

  /**
   * Append content to a file, creating it if it doesn't exist.
   */
  appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void>;

  exists(path: string): Promise<boolean>;

  stat(path: string): Promise<FsStat>;

  mkdir(path: string, options?: MkdirOptions): Promise<void>;

  readdir(path: string): Promise<string[]>;

  readdirWithFileTypes?(path: string): Promise<DirentEntry[]>;

  rm(path: string, options?: RmOptions): Promise<void>;

  cp(src: string, dest: string, options?: CpOptions): Promise<void>;

  mv(src: string, dest: string): Promise<void>;

  resolvePath(base: string, path: string): string;

  getAllPaths(): string[];

  chmod(path: string, mode: number): Promise<void>;

  symlink(target: string, linkPath: string): Promise<void>;

  link(existingPath: string, newPath: string): Promise<void>;

  readlink(path: string): Promise<string>;

  lstat(path: string): Promise<FsStat>;

  realpath(path: string): Promise<string>;

  utimes(path: string, atime: Date, mtime: Date): Promise<void>;
}

/**
 * Extended file initialization options with optional metadata
 */
export interface FileInit {
  content: FileContent;
  mode?: number;
  mtime?: Date;
}

/**
 * Initial files can be simple content or extended options with metadata
 */
export type InitialFiles = Record<string, FileContent | FileInit>;

/**
 * Factory function type for creating filesystem instances
 */
export type FileSystemFactory = (initialFiles?: InitialFiles) => IFileSystem;
