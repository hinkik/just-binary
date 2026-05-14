import { type ByteStream, fromChunks } from "../../utils/stream.js";
import {
  contentToChunks,
  contentToChunksSync,
  decodeChunks,
  getEncoding,
} from "../encoding.js";
import type {
  BufferEncoding,
  CpOptions,
  DirectoryEntry,
  DirentEntry,
  FileContent,
  FileEntry,
  FileInit,
  FsEntry,
  FsStat,
  IFileSystem,
  InitialFiles,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  SymlinkEntry,
  WriteFileOptions,
} from "../interface.js";

// Re-export for convenience
export type {
  BufferEncoding,
  FileContent,
  FileEntry,
  DirectoryEntry,
  SymlinkEntry,
  FsEntry,
  FsStat,
  IFileSystem,
};

export interface FsData {
  [path: string]: FsEntry;
}

/**
 * Type guard to check if a value is a FileInit object
 */
function isFileInit(value: FileContent | FileInit): value is FileInit {
  return (
    typeof value === "object" &&
    value !== null &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ReadableStream) &&
    "content" in value
  );
}

/**
 * Validate that a path does not contain null bytes.
 */
function validatePath(path: string, operation: string): void {
  if (path.includes("\0")) {
    throw new Error(`ENOENT: path contains null byte, ${operation} '${path}'`);
  }
}

export class InMemoryFs implements IFileSystem {
  private data: Map<string, FsEntry> = new Map();

  constructor(initialFiles?: InitialFiles) {
    this.data.set("/", { type: "directory", mode: 0o755, mtime: new Date() });

    if (initialFiles) {
      for (const [path, value] of Object.entries(initialFiles)) {
        if (isFileInit(value)) {
          // FileInit only supports sync content (string | Uint8Array). Streams
          // in initialFiles are rejected — use writeFile() after construction.
          if (value.content instanceof ReadableStream) {
            throw new Error(
              "InMemoryFs: streams not supported in InitialFiles; use writeFile() after construction",
            );
          }
          this.writeFileSync(path, value.content, undefined, {
            mode: value.mode,
            mtime: value.mtime,
          });
        } else {
          if (value instanceof ReadableStream) {
            throw new Error(
              "InMemoryFs: streams not supported in InitialFiles; use writeFile() after construction",
            );
          }
          this.writeFileSync(path, value);
        }
      }
    }
  }

  private normalizePath(path: string): string {
    if (!path || path === "/") return "/";
    let normalized =
      path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
    if (!normalized.startsWith("/")) {
      normalized = `/${normalized}`;
    }
    const parts = normalized.split("/").filter((p) => p && p !== ".");
    const resolved: string[] = [];
    for (const part of parts) {
      if (part === "..") resolved.pop();
      else resolved.push(part);
    }
    return `/${resolved.join("/")}` || "/";
  }

  private dirname(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === "/") return "/";
    const lastSlash = normalized.lastIndexOf("/");
    return lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
  }

  private ensureParentDirs(path: string): void {
    const dir = this.dirname(path);
    if (dir === "/") return;
    if (!this.data.has(dir)) {
      this.ensureParentDirs(dir);
      this.data.set(dir, { type: "directory", mode: 0o755, mtime: new Date() });
    }
  }

  /**
   * Synchronous file write. Accepts string or Uint8Array only (no streams).
   * Used during construction and by init.ts for seeding /dev, /proc, /bin
   * stubs. Internally stored chunked.
   */
  writeFileSync(
    path: string,
    content: string | Uint8Array,
    options?: WriteFileOptions | BufferEncoding,
    metadata?: { mode?: number; mtime?: Date },
  ): void {
    validatePath(path, "write");
    const normalized = this.normalizePath(path);
    this.ensureParentDirs(normalized);

    const encoding = getEncoding(options);
    const { chunks, size } = contentToChunksSync(content, encoding);

    this.data.set(normalized, {
      type: "file",
      chunks,
      size,
      mode: metadata?.mode ?? 0o644,
      mtime: metadata?.mtime ?? new Date(),
    });
  }

  async readFile(path: string): Promise<ByteStream> {
    validatePath(path, "open");
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }

    return fromChunks(entry.chunks);
  }

  async readFileText(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    validatePath(path, "open");
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);
    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== "file") {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }
    const encoding = getEncoding(options);
    return decodeChunks(entry.chunks, encoding);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "write");
    const normalized = this.normalizePath(path);
    this.ensureParentDirs(normalized);

    const encoding = getEncoding(options);
    const { chunks, size } = await contentToChunks(content, encoding);

    this.data.set(normalized, {
      type: "file",
      chunks,
      size,
      mode: 0o644,
      mtime: new Date(),
    });
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    validatePath(path, "append");
    const normalized = this.normalizePath(path);
    const existing = this.data.get(normalized);

    if (existing && existing.type === "directory") {
      throw new Error(
        `EISDIR: illegal operation on a directory, write '${path}'`,
      );
    }

    const encoding = getEncoding(options);
    const { chunks: newChunks, size: newSize } = await contentToChunks(
      content,
      encoding,
    );

    if (existing?.type === "file") {
      this.data.set(normalized, {
        type: "file",
        chunks: [...existing.chunks, ...newChunks],
        size: existing.size + newSize,
        mode: existing.mode,
        mtime: new Date(),
      });
    } else {
      this.ensureParentDirs(normalized);
      this.data.set(normalized, {
        type: "file",
        chunks: newChunks,
        size: newSize,
        mode: 0o644,
        mtime: new Date(),
      });
    }
  }

  async exists(path: string): Promise<boolean> {
    if (path.includes("\0")) return false;
    try {
      const resolvedPath = this.resolvePathWithSymlinks(path);
      return this.data.has(resolvedPath);
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    validatePath(path, "stat");
    const resolvedPath = this.resolvePathWithSymlinks(path);
    const entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    let size = 0;
    if (entry.type === "file") {
      size = entry.size;
    }

    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      mode: entry.mode,
      size,
      mtime: entry.mtime || new Date(),
    };
  }

  async lstat(path: string): Promise<FsStat> {
    validatePath(path, "lstat");
    const resolvedPath = this.resolveIntermediateSymlinks(path);
    const entry = this.data.get(resolvedPath);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
    }

    if (entry.type === "symlink") {
      return {
        isFile: false,
        isDirectory: false,
        isSymbolicLink: true,
        mode: entry.mode,
        size: entry.target.length,
        mtime: entry.mtime || new Date(),
      };
    }

    let size = 0;
    if (entry.type === "file") {
      size = entry.size;
    }

    return {
      isFile: entry.type === "file",
      isDirectory: entry.type === "directory",
      isSymbolicLink: false,
      mode: entry.mode,
      size,
      mtime: entry.mtime || new Date(),
    };
  }

  private resolveSymlink(symlinkPath: string, target: string): string {
    if (target.startsWith("/")) {
      return this.normalizePath(target);
    }
    const dir = this.dirname(symlinkPath);
    return this.normalizePath(dir === "/" ? `/${target}` : `${dir}/${target}`);
  }

  private resolveIntermediateSymlinks(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === "/") return "/";

    const parts = normalized.slice(1).split("/");
    if (parts.length <= 1) return normalized;

    let resolvedPath = "";
    const seen = new Set<string>();

    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      resolvedPath = `${resolvedPath}/${part}`;

      let entry = this.data.get(resolvedPath);
      let loopCount = 0;
      const maxLoops = 40;

      while (entry && entry.type === "symlink" && loopCount < maxLoops) {
        if (seen.has(resolvedPath)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, lstat '${path}'`,
          );
        }
        seen.add(resolvedPath);
        resolvedPath = this.resolveSymlink(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }

      if (loopCount >= maxLoops) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, lstat '${path}'`,
        );
      }
    }

    return `${resolvedPath}/${parts[parts.length - 1]}`;
  }

  private resolvePathWithSymlinks(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === "/") return "/";

    const parts = normalized.slice(1).split("/");
    let resolvedPath = "";
    const seen = new Set<string>();

    for (const part of parts) {
      resolvedPath = `${resolvedPath}/${part}`;

      let entry = this.data.get(resolvedPath);
      let loopCount = 0;
      const maxLoops = 40;

      while (entry && entry.type === "symlink" && loopCount < maxLoops) {
        if (seen.has(resolvedPath)) {
          throw new Error(
            `ELOOP: too many levels of symbolic links, open '${path}'`,
          );
        }
        seen.add(resolvedPath);
        resolvedPath = this.resolveSymlink(resolvedPath, entry.target);
        entry = this.data.get(resolvedPath);
        loopCount++;
      }

      if (loopCount >= maxLoops) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, open '${path}'`,
        );
      }
    }

    return resolvedPath;
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.mkdirSync(path, options);
  }

  mkdirSync(path: string, options?: MkdirOptions): void {
    validatePath(path, "mkdir");
    const normalized = this.normalizePath(path);

    if (this.data.has(normalized)) {
      const entry = this.data.get(normalized);
      if (entry?.type === "file") {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return;
    }

    const parent = this.dirname(normalized);
    if (parent !== "/" && !this.data.has(parent)) {
      if (options?.recursive) {
        this.mkdirSync(parent, { recursive: true });
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }

    this.data.set(normalized, {
      type: "directory",
      mode: 0o755,
      mtime: new Date(),
    });
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    validatePath(path, "scandir");
    let normalized = this.normalizePath(path);
    let entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }

    const seen = new Set<string>();
    while (entry && entry.type === "symlink") {
      if (seen.has(normalized)) {
        throw new Error(
          `ELOOP: too many levels of symbolic links, scandir '${path}'`,
        );
      }
      seen.add(normalized);
      normalized = this.resolveSymlink(normalized, entry.target);
      entry = this.data.get(normalized);
    }

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== "directory") {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const prefix = normalized === "/" ? "/" : `${normalized}/`;
    const entriesMap = new Map<string, DirentEntry>();

    for (const [p, fsEntry] of this.data.entries()) {
      if (p === normalized) continue;
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const name = rest.split("/")[0];
        if (name && !rest.includes("/", name.length) && !entriesMap.has(name)) {
          entriesMap.set(name, {
            name,
            isFile: fsEntry.type === "file",
            isDirectory: fsEntry.type === "directory",
            isSymbolicLink: fsEntry.type === "symlink",
          });
        }
      }
    }

    return Array.from(entriesMap.values()).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    validatePath(path, "rm");
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (entry.type === "directory") {
      const children = await this.readdir(normalized);
      if (children.length > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        for (const child of children) {
          const childPath =
            normalized === "/" ? `/${child}` : `${normalized}/${child}`;
          await this.rm(childPath, options);
        }
      }
    }

    this.data.delete(normalized);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    validatePath(src, "cp");
    validatePath(dest, "cp");
    const srcNorm = this.normalizePath(src);
    const destNorm = this.normalizePath(dest);
    const srcEntry = this.data.get(srcNorm);

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    if (srcEntry.type === "file") {
      this.ensureParentDirs(destNorm);
      // Copy file entry — share chunk references (chunks are immutable
      // arrays of Uint8Array; we never mutate in place).
      this.data.set(destNorm, {
        type: "file",
        chunks: [...srcEntry.chunks],
        size: srcEntry.size,
        mode: srcEntry.mode,
        mtime: srcEntry.mtime,
      });
    } else if (srcEntry.type === "directory") {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdir(srcNorm);
      for (const child of children) {
        const srcChild = srcNorm === "/" ? `/${child}` : `${srcNorm}/${child}`;
        const destChild =
          destNorm === "/" ? `/${child}` : `${destNorm}/${child}`;
        await this.cp(srcChild, destChild, options);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  getAllPaths(): string[] {
    return Array.from(this.data.keys());
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) {
      return this.normalizePath(path);
    }
    const combined = base === "/" ? `/${path}` : `${base}/${path}`;
    return this.normalizePath(combined);
  }

  async chmod(path: string, mode: number): Promise<void> {
    validatePath(path, "chmod");
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
    }

    entry.mode = mode;
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    validatePath(linkPath, "symlink");
    const normalized = this.normalizePath(linkPath);

    if (this.data.has(normalized)) {
      throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
    }

    this.ensureParentDirs(normalized);
    this.data.set(normalized, {
      type: "symlink",
      target,
      mode: 0o777,
      mtime: new Date(),
    });
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    validatePath(existingPath, "link");
    validatePath(newPath, "link");
    const existingNorm = this.normalizePath(existingPath);
    const newNorm = this.normalizePath(newPath);

    const entry = this.data.get(existingNorm);
    if (!entry) {
      throw new Error(
        `ENOENT: no such file or directory, link '${existingPath}'`,
      );
    }

    if (entry.type !== "file") {
      throw new Error(`EPERM: operation not permitted, link '${existingPath}'`);
    }

    if (this.data.has(newNorm)) {
      throw new Error(`EEXIST: file already exists, link '${newPath}'`);
    }

    this.ensureParentDirs(newNorm);
    this.data.set(newNorm, {
      type: "file",
      chunks: [...entry.chunks],
      size: entry.size,
      mode: entry.mode,
      mtime: entry.mtime,
    });
  }

  async readlink(path: string): Promise<string> {
    validatePath(path, "readlink");
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, readlink '${path}'`);
    }

    if (entry.type !== "symlink") {
      throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
    }

    return entry.target;
  }

  async realpath(path: string): Promise<string> {
    validatePath(path, "realpath");
    const resolved = this.resolvePathWithSymlinks(path);

    if (!this.data.has(resolved)) {
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    }

    return resolved;
  }

  async utimes(path: string, _atime: Date, mtime: Date): Promise<void> {
    validatePath(path, "utimes");
    const normalized = this.normalizePath(path);
    const resolved = this.resolvePathWithSymlinks(normalized);
    const entry = this.data.get(resolved);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
    }

    entry.mtime = mtime;
  }
}
