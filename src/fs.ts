import {
  IFileSystem,
  FsEntry,
  FileEntry,
  DirectoryEntry,
  FsStat,
  MkdirOptions,
  RmOptions,
  CpOptions,
} from './fs-interface.js';

// Re-export for backwards compatibility
export type { FileEntry, DirectoryEntry, FsEntry, FsStat, IFileSystem };

export interface FsData {
  [path: string]: FsEntry;
}

export class VirtualFs implements IFileSystem {
  private data: Map<string, FsEntry> = new Map();

  constructor(initialFiles?: Record<string, string>) {
    // Create root directory
    this.data.set('/', { type: 'directory', mode: 0o755 });

    if (initialFiles) {
      for (const [path, content] of Object.entries(initialFiles)) {
        this.writeFileSync(path, content);
      }
    }
  }

  private normalizePath(path: string): string {
    // Handle empty or just slash
    if (!path || path === '/') return '/';

    // Remove trailing slash
    let normalized = path.endsWith('/') && path !== '/'
      ? path.slice(0, -1)
      : path;

    // Ensure starts with /
    if (!normalized.startsWith('/')) {
      normalized = '/' + normalized;
    }

    // Resolve . and ..
    const parts = normalized.split('/').filter(p => p && p !== '.');
    const resolved: string[] = [];

    for (const part of parts) {
      if (part === '..') {
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    return '/' + resolved.join('/') || '/';
  }

  private dirname(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === '/') return '/';
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash === 0 ? '/' : normalized.slice(0, lastSlash);
  }

  private basename(path: string): string {
    const normalized = this.normalizePath(path);
    if (normalized === '/') return '';
    return normalized.split('/').pop() || '';
  }

  private ensureParentDirs(path: string): void {
    const dir = this.dirname(path);
    if (dir === '/') return;

    if (!this.data.has(dir)) {
      this.ensureParentDirs(dir);
      this.data.set(dir, { type: 'directory', mode: 0o755 });
    }
  }

  // Sync methods (internal use)
  private writeFileSync(path: string, content: string): void {
    const normalized = this.normalizePath(path);
    this.ensureParentDirs(normalized);
    this.data.set(normalized, { type: 'file', content, mode: 0o644 });
  }

  // Async public API
  async readFile(path: string): Promise<string> {
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`);
    }
    if (entry.type !== 'file') {
      throw new Error(`EISDIR: illegal operation on a directory, read '${path}'`);
    }

    return entry.content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.writeFileSync(path, content);
  }

  async appendFile(path: string, content: string): Promise<void> {
    const normalized = this.normalizePath(path);
    const existing = this.data.get(normalized);

    if (existing && existing.type === 'directory') {
      throw new Error(`EISDIR: illegal operation on a directory, write '${path}'`);
    }

    const currentContent = existing?.type === 'file' ? existing.content : '';
    this.writeFileSync(path, currentContent + content);
  }

  async exists(path: string): Promise<boolean> {
    return this.data.has(this.normalizePath(path));
  }

  async stat(path: string): Promise<FsStat> {
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
    }

    return {
      isFile: entry.type === 'file',
      isDirectory: entry.type === 'directory',
      mode: entry.mode,
    };
  }

  async mkdir(path: string, options?: MkdirOptions): Promise<void> {
    this.mkdirSync(path, options);
  }

  /**
   * Synchronous version of mkdir
   */
  mkdirSync(path: string, options?: MkdirOptions): void {
    const normalized = this.normalizePath(path);

    if (this.data.has(normalized)) {
      const entry = this.data.get(normalized);
      if (entry?.type === 'file') {
        throw new Error(`EEXIST: file already exists, mkdir '${path}'`);
      }
      // Directory already exists
      if (!options?.recursive) {
        throw new Error(`EEXIST: directory already exists, mkdir '${path}'`);
      }
      return; // With -p, silently succeed if directory exists
    }

    const parent = this.dirname(normalized);
    if (parent !== '/' && !this.data.has(parent)) {
      if (options?.recursive) {
        this.mkdirSync(parent, { recursive: true });
      } else {
        throw new Error(`ENOENT: no such file or directory, mkdir '${path}'`);
      }
    }

    this.data.set(normalized, { type: 'directory', mode: 0o755 });
  }

  async readdir(path: string): Promise<string[]> {
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      throw new Error(`ENOENT: no such file or directory, scandir '${path}'`);
    }
    if (entry.type !== 'directory') {
      throw new Error(`ENOTDIR: not a directory, scandir '${path}'`);
    }

    const prefix = normalized === '/' ? '/' : normalized + '/';
    const entries: string[] = [];

    for (const p of this.data.keys()) {
      if (p === normalized) continue;
      if (p.startsWith(prefix)) {
        const rest = p.slice(prefix.length);
        const name = rest.split('/')[0];
        if (name && !entries.includes(name)) {
          entries.push(name);
        }
      }
    }

    return entries.sort();
  }

  async rm(path: string, options?: RmOptions): Promise<void> {
    const normalized = this.normalizePath(path);
    const entry = this.data.get(normalized);

    if (!entry) {
      if (options?.force) return;
      throw new Error(`ENOENT: no such file or directory, rm '${path}'`);
    }

    if (entry.type === 'directory') {
      const children = await this.readdir(normalized);
      if (children.length > 0) {
        if (!options?.recursive) {
          throw new Error(`ENOTEMPTY: directory not empty, rm '${path}'`);
        }
        for (const child of children) {
          const childPath = normalized === '/' ? '/' + child : normalized + '/' + child;
          await this.rm(childPath, options);
        }
      }
    }

    this.data.delete(normalized);
  }

  async cp(src: string, dest: string, options?: CpOptions): Promise<void> {
    const srcNorm = this.normalizePath(src);
    const destNorm = this.normalizePath(dest);
    const srcEntry = this.data.get(srcNorm);

    if (!srcEntry) {
      throw new Error(`ENOENT: no such file or directory, cp '${src}'`);
    }

    if (srcEntry.type === 'file') {
      this.ensureParentDirs(destNorm);
      this.data.set(destNorm, { ...srcEntry });
    } else if (srcEntry.type === 'directory') {
      if (!options?.recursive) {
        throw new Error(`EISDIR: is a directory, cp '${src}'`);
      }
      await this.mkdir(destNorm, { recursive: true });
      const children = await this.readdir(srcNorm);
      for (const child of children) {
        const srcChild = srcNorm === '/' ? '/' + child : srcNorm + '/' + child;
        const destChild = destNorm === '/' ? '/' + child : destNorm + '/' + child;
        await this.cp(srcChild, destChild, options);
      }
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.cp(src, dest, { recursive: true });
    await this.rm(src, { recursive: true });
  }

  // Get all paths (useful for debugging/glob)
  getAllPaths(): string[] {
    return Array.from(this.data.keys());
  }

  // Resolve a path relative to a base
  resolvePath(base: string, path: string): string {
    if (path.startsWith('/')) {
      return this.normalizePath(path);
    }
    const combined = base === '/' ? '/' + path : base + '/' + path;
    return this.normalizePath(combined);
  }
}
