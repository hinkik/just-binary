import { Command, CommandContext, ExecResult } from '../../types.js';

export const cpCommand: Command = {
  name: 'cp',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let recursive = false;
    const paths: string[] = [];

    // Parse arguments
    for (const arg of args) {
      if (arg === '-r' || arg === '-R' || arg === '--recursive') {
        recursive = true;
      } else if (arg.startsWith('-')) {
        // Ignore other flags
      } else {
        paths.push(arg);
      }
    }

    if (paths.length < 2) {
      return {
        stdout: '',
        stderr: 'cp: missing destination file operand\n',
        exitCode: 1,
      };
    }

    const dest = paths.pop()!;
    const sources = paths;
    const destPath = ctx.fs.resolvePath(ctx.cwd, dest);

    let stderr = '';
    let exitCode = 0;

    // Check if dest is a directory
    let destIsDir = false;
    try {
      const stat = await ctx.fs.stat(destPath);
      destIsDir = stat.isDirectory;
    } catch {
      // Dest doesn't exist
    }

    // If multiple sources, dest must be a directory
    if (sources.length > 1 && !destIsDir) {
      return {
        stdout: '',
        stderr: `cp: target '${dest}' is not a directory\n`,
        exitCode: 1,
      };
    }

    for (const src of sources) {
      try {
        const srcPath = ctx.fs.resolvePath(ctx.cwd, src);
        const srcStat = await ctx.fs.stat(srcPath);

        let targetPath = destPath;
        if (destIsDir) {
          const basename = src.split('/').pop() || src;
          targetPath = destPath === '/' ? '/' + basename : destPath + '/' + basename;
        }

        if (srcStat.isDirectory && !recursive) {
          stderr += `cp: -r not specified; omitting directory '${src}'\n`;
          exitCode = 1;
          continue;
        }

        await ctx.fs.cp(srcPath, targetPath, { recursive });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ENOENT') || message.includes('no such file')) {
          stderr += `cp: cannot stat '${src}': No such file or directory\n`;
        } else {
          stderr += `cp: cannot copy '${src}': ${message}\n`;
        }
        exitCode = 1;
      }
    }

    return { stdout: '', stderr, exitCode };
  },
};
