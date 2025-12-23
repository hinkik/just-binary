import { Command, CommandContext, ExecResult } from '../../types.js';
import { minimatch } from 'minimatch';
import { hasHelpFlag, showHelp, unknownOption } from '../help.js';

const lsHelp = {
  name: 'ls',
  summary: 'list directory contents',
  usage: 'ls [OPTION]... [FILE]...',
  options: [
    '-a, --all            do not ignore entries starting with .',
    '-A, --almost-all     do not list . and ..',
    '-d, --directory      list directories themselves, not their contents',
    '-l                   use a long listing format',
    '-r, --reverse        reverse order while sorting',
    '-R, --recursive      list subdirectories recursively',
    '-t                   sort by time, newest first',
    '-1                   list one file per line',
    '    --help           display this help and exit',
  ],
};

export const lsCommand: Command = {
  name: 'ls',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(lsHelp);
    }

    let showAll = false;
    let showAlmostAll = false;
    let longFormat = false;
    let recursive = false;
    let reverse = false;
    let directoryOnly = false;
    let sortByTime = false;
    const paths: string[] = [];

    // Parse arguments
    for (const arg of args) {
      if (arg.startsWith('-') && !arg.startsWith('--')) {
        for (const flag of arg.slice(1)) {
          if (flag === 'a') showAll = true;
          else if (flag === 'A') showAlmostAll = true;
          else if (flag === 'l') longFormat = true;
          else if (flag === 'R') recursive = true;
          else if (flag === 'r') reverse = true;
          else if (flag === 'd') directoryOnly = true;
          else if (flag === 't') sortByTime = true;
          else if (flag === '1') { /* -1 is implicit */ }
          else {
            return unknownOption('ls', `-${flag}`);
          }
        }
      } else if (arg === '--all') {
        showAll = true;
      } else if (arg === '--almost-all') {
        showAlmostAll = true;
      } else if (arg === '--reverse') {
        reverse = true;
      } else if (arg === '--directory') {
        directoryOnly = true;
      } else if (arg === '--recursive') {
        recursive = true;
      } else if (arg.startsWith('--')) {
        return unknownOption('ls', arg);
      } else {
        paths.push(arg);
      }
    }

    if (paths.length === 0) {
      paths.push('.');
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    for (let i = 0; i < paths.length; i++) {
      const path = paths[i];

      // Add blank line between directory listings
      if (i > 0 && stdout && !stdout.endsWith('\n\n')) {
        stdout += '\n';
      }

      // Check if it's a glob pattern
      if (path.includes('*') || path.includes('?') || path.includes('[')) {
        const result = await listGlob(path, ctx, showAll, showAlmostAll, longFormat, reverse);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0) exitCode = result.exitCode;
      } else {
        const result = await listPath(path, ctx, showAll, showAlmostAll, longFormat, recursive, paths.length > 1, reverse);
        stdout += result.stdout;
        stderr += result.stderr;
        if (result.exitCode !== 0) exitCode = result.exitCode;
      }
    }

    return { stdout, stderr, exitCode };
  },
};

async function listGlob(
  pattern: string,
  ctx: CommandContext,
  showAll: boolean,
  showAlmostAll: boolean,
  longFormat: boolean,
  reverse: boolean = false
): Promise<ExecResult> {
  const showHidden = showAll || showAlmostAll;
  const allPaths = ctx.fs.getAllPaths();
  const basePath = ctx.fs.resolvePath(ctx.cwd, '.');

  const matches: string[] = [];
  for (const p of allPaths) {
    const relativePath = p.startsWith(basePath)
      ? p.slice(basePath.length + 1) || p
      : p;

    if (minimatch(relativePath, pattern) || minimatch(p, pattern)) {
      // Filter hidden files unless showHidden
      const basename = relativePath.split('/').pop() || relativePath;
      if (!showHidden && basename.startsWith('.')) {
        continue;
      }
      matches.push(relativePath || p);
    }
  }

  if (matches.length === 0) {
    return {
      stdout: '',
      stderr: `ls: ${pattern}: No such file or directory\n`,
      exitCode: 2,
    };
  }

  matches.sort();
  if (reverse) {
    matches.reverse();
  }

  if (longFormat) {
    const lines: string[] = [];
    for (const match of matches) {
      const fullPath = ctx.fs.resolvePath(ctx.cwd, match);
      try {
        const stat = await ctx.fs.stat(fullPath);
        const mode = stat.isDirectory ? 'drwxr-xr-x' : '-rw-r--r--';
        const type = stat.isDirectory ? '/' : '';
        lines.push(`${mode} 1 user user    0 Jan  1 00:00 ${match}${type}`);
      } catch {
        lines.push(`-rw-r--r-- 1 user user    0 Jan  1 00:00 ${match}`);
      }
    }
    return { stdout: lines.join('\n') + '\n', stderr: '', exitCode: 0 };
  }

  return { stdout: matches.join('\n') + '\n', stderr: '', exitCode: 0 };
}

async function listPath(
  path: string,
  ctx: CommandContext,
  showAll: boolean,
  showAlmostAll: boolean,
  longFormat: boolean,
  recursive: boolean,
  showHeader: boolean,
  reverse: boolean = false,
  isSubdir: boolean = false
): Promise<ExecResult> {
  const showHidden = showAll || showAlmostAll;
  const fullPath = ctx.fs.resolvePath(ctx.cwd, path);

  try {
    const stat = await ctx.fs.stat(fullPath);

    if (!stat.isDirectory) {
      // It's a file, just show it
      if (longFormat) {
        return {
          stdout: `-rw-r--r-- 1 user user    0 Jan  1 00:00 ${path}\n`,
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: path + '\n', stderr: '', exitCode: 0 };
    }

    // It's a directory
    let entries = await ctx.fs.readdir(fullPath);

    // Filter hidden files unless -a or -A
    if (!showHidden) {
      entries = entries.filter(e => !e.startsWith('.'));
    }

    // Sort entries (already sorted by readdir, but ensure consistent order)
    entries.sort();

    // Add . and .. entries for -a flag (but not for -A)
    if (showAll) {
      entries = ['.', '..', ...entries];
    }

    if (reverse) {
      entries.reverse();
    }

    let stdout = '';

    // For recursive listing:
    // - First directory doesn't get a header (unless multiple paths)
    // - Subdirectories get header with path
    // - When starting from '.', subdirs use './subdir:' format
    // - When starting from other path, subdirs use '{path}/subdir:' format
    if (recursive && isSubdir) {
      stdout += `${path}:\n`;
    } else if (showHeader) {
      stdout += `${path}:\n`;
    }

    if (longFormat) {
      stdout += `total ${entries.length}\n`;
      for (const entry of entries) {
        // Handle . and .. specially
        if (entry === '.' || entry === '..') {
          stdout += `drwxr-xr-x 1 user user    0 Jan  1 00:00 ${entry}\n`;
          continue;
        }
        const entryPath = fullPath === '/' ? '/' + entry : fullPath + '/' + entry;
        try {
          const entryStat = await ctx.fs.stat(entryPath);
          const mode = entryStat.isDirectory ? 'drwxr-xr-x' : '-rw-r--r--';
          const suffix = entryStat.isDirectory ? '/' : '';
          stdout += `${mode} 1 user user    0 Jan  1 00:00 ${entry}${suffix}\n`;
        } catch {
          stdout += `-rw-r--r-- 1 user user    0 Jan  1 00:00 ${entry}\n`;
        }
      }
    } else {
      stdout += entries.join('\n') + (entries.length ? '\n' : '');
    }

    // Handle recursive
    if (recursive) {
      for (const entry of entries) {
        // Skip . and .. for recursive listing
        if (entry === '.' || entry === '..') {
          continue;
        }
        const entryPath = fullPath === '/' ? '/' + entry : fullPath + '/' + entry;
        try {
          const entryStat = await ctx.fs.stat(entryPath);
          if (entryStat.isDirectory) {
            stdout += '\n';
            // Build subPath with proper format:
            // - From '.', subdirs become './subdir'
            // - From '/dir', subdirs become '/dir/subdir'
            const subPath = path === '.' ? `./${entry}` : `${path}/${entry}`;
            const result = await listPath(subPath, ctx, showAll, showAlmostAll, longFormat, recursive, false, reverse, true);
            stdout += result.stdout;
          }
        } catch {
          // Skip
        }
      }
    }

    return { stdout, stderr: '', exitCode: 0 };
  } catch {
    return {
      stdout: '',
      stderr: `ls: ${path}: No such file or directory\n`,
      exitCode: 2,
    };
  }
}
