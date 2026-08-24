/**
 * ReadWriteFs - Direct wrapper around the real filesystem
 *
 * All operations go directly to the underlying Node.js filesystem.
 * Paths are relative to the configured root directory.
 *
 * Security: Symlink targets are validated and transformed to stay within root,
 * preventing symlink-based sandbox escape attacks.
 */

import * as fs from "node:fs";
import * as nodePath from "node:path";
import { Readable } from "node:stream";
import { type ByteStream, collectBytes } from "../../utils/stream.js";
import { contentToChunks, getEncoding } from "../encoding.js";
import type {
  BufferEncoding,
  CpOptions,
  DirentEntry,
  FileAppender,
  FileContent,
  FsStat,
  IFileSystem,
  MkdirOptions,
  ReadFileOptions,
  RmOptions,
  WriteFileOptions,
} from "../interface.js";
import { validateRange } from "../range.js";

export interface ReadWriteFsOptions {
  /**
   * The root directory on the real filesystem.
   * All paths are relative to this root.
   */
  root: string;

  /**
   * Maximum file size in bytes that can be read.
   * Files larger than this will throw an EFBIG error.
   * Defaults to 10MB (10485760).
   */
  maxFileReadSize?: number;
}

export class ReadWriteFs implements IFileSystem {
  private readonly root: string;
  private readonly maxFileReadSize: number;

  constructor(options: ReadWriteFsOptions) {
    this.root = nodePath.resolve(options.root);
    this.maxFileReadSize = options.maxFileReadSize ?? 10485760;

    // Verify root exists and is a directory
    if (!fs.existsSync(this.root)) {
      throw new Error(`ReadWriteFs root does not exist: ${this.root}`);
    }
    const stat = fs.statSync(this.root);
    if (!stat.isDirectory()) {
      throw new Error(`ReadWriteFs root is not a directory: ${this.root}`);
    }
  }

  /**
   * Convert a virtual path to a real filesystem path.
   */
  private toRealPath(virtualPath: string): string {
    const normalized = this.normalizePath(virtualPath);
    const realPath = nodePath.join(this.root, normalized);
    return nodePath.resolve(realPath);
  }

  /**
   * Normalize a virtual path (resolve . and .., ensure starts with /)
   */
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
      if (part === "..") {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return `/${resolved.join("/")}` || "/";
  }

  async readFile(path: string): Promise<ByteStream> {
    const realPath = this.toRealPath(path);

    try {
      const stat = await fs.promises.lstat(realPath);
      if (stat.isDirectory()) {
        throw new Error(
          `EISDIR: illegal operation on a directory, read '${path}'`,
        );
      }
      if (this.maxFileReadSize > 0 && stat.size > this.maxFileReadSize) {
        throw new Error(
          `EFBIG: file too large, read '${path}' (${stat.size} bytes, max ${this.maxFileReadSize})`,
        );
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      throw e;
    }

    // Node Readable → Web ReadableStream<Uint8Array>
    const nodeStream = fs.createReadStream(realPath);
    return Readable.toWeb(nodeStream) as ByteStream;
  }

  async readRange(
    path: string,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    validateRange(offset, length);
    const realPath = this.toRealPath(path);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(realPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, open '${path}'`);
      }
      throw e;
    }
    if (stat.isDirectory()) {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${path}'`,
      );
    }

    if (length === 0 || offset >= stat.size) {
      return new Uint8Array(0);
    }
    const clamped = Math.min(length, stat.size - offset);
    const buf = new Uint8Array(clamped);
    const handle = await fs.promises.open(realPath, "r");
    try {
      const { bytesRead } = await handle.read(buf, 0, clamped, offset);
      return bytesRead === clamped ? buf : buf.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async readFileText(
    path: string,
    options?: ReadFileOptions | BufferEncoding,
  ): Promise<string> {
    const stream = await this.readFile(path);
    const bytes = await collectBytes(stream);
    const encoding = getEncoding(options) ?? "utf8";
    // Use TextDecoder for utf8; for other encodings, fall back to Buffer.
    if (encoding === "utf8" || encoding === "utf-8") {
      return new TextDecoder().decode(bytes);
    }
    if (typeof Buffer !== "undefined") {
      return Buffer.from(bytes).toString(encoding as BufferEncoding);
    }
    return new TextDecoder().decode(bytes);
  }

  async writeFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const realPath = this.toRealPath(path);
    const encoding = getEncoding(options);

    // Ensure parent directory exists
    const dir = nodePath.dirname(realPath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Collect content (stream or otherwise) to bytes via chunks helper.
    const { chunks, size } = await contentToChunks(content, encoding);
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      buffer.set(c, offset);
      offset += c.length;
    }
    await fs.promises.writeFile(realPath, buffer);
  }

  async appendFile(
    path: string,
    content: FileContent,
    options?: WriteFileOptions | BufferEncoding,
  ): Promise<void> {
    const realPath = this.toRealPath(path);
    const encoding = getEncoding(options);

    // Ensure parent directory exists
    const dir = nodePath.dirname(realPath);
    await fs.promises.mkdir(dir, { recursive: true });

    const { chunks, size } = await contentToChunks(content, encoding);
    const buffer = new Uint8Array(size);
    let offset = 0;
    for (const c of chunks) {
      buffer.set(c, offset);
      offset += c.length;
    }
    await fs.promises.appendFile(realPath, buffer);
  }

  async openFileAppender(path: string): Promise<FileAppender> {
    const realPath = this.toRealPath(path);
    const dir = nodePath.dirname(realPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const handle = await fs.promises.open(realPath, "a");
    return {
      append: async (chunk: Uint8Array) => {
        await handle.write(chunk);
      },
      close: async () => {
        await handle.close();
      },
    };
  }

  async exists(path: string): Promise<boolean> {
    const realPath = this.toRealPath(path);
    try {
      await fs.promises.access(realPath);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<FsStat> {
    const realPath = this.toRealPath(path);

    try {
      const stat = await fs.promises.stat(realPath);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: false, // stat follows symlinks
        mode: stat.mode,
        size: stat.size,
        mtime: stat.mtime,
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
      }
      throw e;
    }
  }

  async lstat(path: string): Promise<FsStat> {
    const realPath = this.toRealPath(path);

    try {
      const stat = await fs.promises.lstat(realPath);
      return {
        isFile: stat.isFile(),
        isDirectory: stat.isDirectory(),
        isSymbolicLink: stat.isSymbolicLink(),
        mode: stat.mode,
        size: stat.size,
        mtime: stat.mtime,
      };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, lstat '${path}'`);
      }
      throw e;
    }
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    const realPath = this.toRealPath(path);

    try {
      await fs.promises.mkdir(realPath, { recursive: options?.recursive });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
      throw e;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const entries = await this.readdirWithFileTypes(path);
    return entries.map((e) => e.name);
  }

  async readdirWithFileTypes(path: string): Promise<DirentEntry[]> {
    const realPath = this.toRealPath(path);

    try {
      const entries = await fs.promises.readdir(realPath, {
        withFileTypes: true,
      });
      return entries
        .map((dirent) => ({
          name: dirent.name,
          isFile: dirent.isFile(),
          isDirectory: dirent.isDirectory(),
          isSymbolicLink: dirent.isSymbolicLink(),
        }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
      }
      if (err.code === "ENOTDIR") {
        throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
      }
      throw e;
    }
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const realPath = this.toRealPath(path);

    try {
      await fs.promises.rm(realPath, {
        recursive: options?.recursive ?? false,
        force: options?.force ?? false,
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT" && !options?.force) {
        throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
      }
      if (err.code === "ENOTEMPTY") {
        throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
      }
      throw e;
    }
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcReal = this.toRealPath(src);
    const destReal = this.toRealPath(dest);

    try {
      await fs.promises.cp(srcReal, destReal, {
        recursive: options?.recursive ?? false,
      });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
      }
      if (err.code === "EISDIR") {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      throw e;
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    const srcReal = this.toRealPath(src);
    const destReal = this.toRealPath(dest);

    // Ensure destination parent directory exists
    const destDir = nodePath.dirname(destReal);
    await fs.promises.mkdir(destDir, { recursive: true });

    try {
      await fs.promises.rename(srcReal, destReal);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, mv '${src}'`);
      }
      // If rename fails across devices, fall back to copy + delete
      if (err.code === "EXDEV") {
        await this.cp(src, dest, { recursive: true });
        await this.rm(src, { recursive: true });
        return;
      }
      throw e;
    }
  }

  resolvePath(base: string, path: string): string {
    if (path.startsWith("/")) {
      return this.normalizePath(path);
    }
    const combined = base === "/" ? `/${path}` : `${base}/${path}`;
    return this.normalizePath(combined);
  }

  getAllPaths(): string[] {
    // Recursively scan the filesystem
    const paths: string[] = [];
    this.scanDir("/", paths);
    return paths;
  }

  private scanDir(virtualDir: string, paths: string[]): void {
    const realPath = this.toRealPath(virtualDir);

    try {
      const entries = fs.readdirSync(realPath);
      for (const entry of entries) {
        const virtualPath =
          virtualDir === "/" ? `/${entry}` : `${virtualDir}/${entry}`;
        paths.push(virtualPath);

        const entryRealPath = nodePath.join(realPath, entry);
        const stat = fs.statSync(entryRealPath);
        if (stat.isDirectory()) {
          this.scanDir(virtualPath, paths);
        }
      }
    } catch {
      // Ignore errors
    }
  }

  async chmod(path: string, mode: number): Promise<void> {
    const realPath = this.toRealPath(path);

    try {
      await fs.promises.chmod(realPath, mode);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, chmod '${path}'`);
      }
      throw e;
    }
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    const realLinkPath = this.toRealPath(linkPath);

    // Validate and transform symlink target to prevent sandbox escape.
    // Resolve the target: if absolute, treat as virtual path; if relative, resolve from link's dir
    const normalizedLinkPath = this.normalizePath(linkPath);
    const linkDir = this.normalizePath(nodePath.dirname(normalizedLinkPath));
    const resolvedVirtualTarget = target.startsWith("/")
      ? this.normalizePath(target)
      : this.normalizePath(
          linkDir === "/" ? `/${target}` : `${linkDir}/${target}`,
        );

    // Convert to real path - this is where the symlink should actually point
    const resolvedRealTarget = nodePath.join(this.root, resolvedVirtualTarget);

    // For relative symlinks, compute the correct relative path from link to target within root
    // For absolute symlinks, use the absolute path within root
    const realLinkDir = nodePath.dirname(realLinkPath);
    const safeTarget = target.startsWith("/")
      ? resolvedRealTarget
      : nodePath.relative(realLinkDir, resolvedRealTarget);

    try {
      await fs.promises.symlink(safeTarget, realLinkPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "EEXIST") {
        throw new Error(`EEXIST: file already exists, symlink '${linkPath}'`);
      }
      throw e;
    }
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    const realExisting = this.toRealPath(existingPath);
    const realNew = this.toRealPath(newPath);

    try {
      await fs.promises.link(realExisting, realNew);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(
          `ENOENT: no such file or directory, link '${existingPath}'`,
        );
      }
      if (err.code === "EEXIST") {
        throw new Error(`EEXIST: file already exists, link '${newPath}'`);
      }
      if (err.code === "EPERM") {
        throw new Error(
          `EPERM: operation not permitted, link '${existingPath}'`,
        );
      }
      throw e;
    }
  }

  async readlink(path: string): Promise<string> {
    const realPath = this.toRealPath(path);

    try {
      return await fs.promises.readlink(realPath);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(
          `ENOENT: no such file or directory, readlink '${path}'`,
        );
      }
      if (err.code === "EINVAL") {
        throw new Error(`EINVAL: invalid argument, readlink '${path}'`);
      }
      throw e;
    }
  }

  /**
   * Resolve all symlinks in a path to get the canonical physical path.
   * This is equivalent to POSIX realpath().
   */
  async realpath(path: string): Promise<string> {
    const realPath = this.toRealPath(path);

    try {
      const resolved = await fs.promises.realpath(realPath);
      // Canonicalize root too (e.g., on macOS /var -> /private/var)
      const canonicalRoot = await fs.promises.realpath(this.root);
      // Convert back to virtual path (relative to root)
      if (resolved.startsWith(canonicalRoot)) {
        const relative = resolved.slice(canonicalRoot.length);
        return relative || "/";
      }
      // Resolved path is outside root - reject it to prevent sandbox escape
      throw new Error(`ENOENT: no such file or directory, realpath '${path}'`);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(
          `ENOENT: no such file or directory, realpath '${path}'`,
        );
      }
      if (err.code === "ELOOP") {
        throw new Error(
          `ELOOP: too many levels of symbolic links, realpath '${path}'`,
        );
      }
      throw e;
    }
  }

  /**
   * Set access and modification times of a file
   * @param path - The file path
   * @param atime - Access time
   * @param mtime - Modification time
   */
  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    const realPath = this.toRealPath(path);

    try {
      await fs.promises.utimes(realPath, atime, mtime);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        throw new Error(`ENOENT: no such file or directory, utimes '${path}'`);
      }
      throw e;
    }
  }
}
