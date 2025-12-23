import { Command, CommandContext, ExecResult } from '../../types.js';
import { unknownOption } from '../help.js';

export const mvCommand: Command = {
  name: 'mv',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const paths: string[] = [];

    // Parse arguments
    for (const arg of args) {
      if (arg.startsWith('--')) {
        return unknownOption('mv', arg);
      } else if (arg.startsWith('-') && arg.length > 1) {
        return unknownOption('mv', arg);
      } else {
        paths.push(arg);
      }
    }

    if (paths.length < 2) {
      return {
        stdout: '',
        stderr: 'mv: missing destination file operand\n',
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
        stderr: `mv: target '${dest}' is not a directory\n`,
        exitCode: 1,
      };
    }

    for (const src of sources) {
      try {
        const srcPath = ctx.fs.resolvePath(ctx.cwd, src);

        let targetPath = destPath;
        if (destIsDir) {
          const basename = src.split('/').pop() || src;
          targetPath = destPath === '/' ? '/' + basename : destPath + '/' + basename;
        }

        await ctx.fs.mv(srcPath, targetPath);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('ENOENT') || message.includes('no such file')) {
          stderr += `mv: cannot stat '${src}': No such file or directory\n`;
        } else {
          stderr += `mv: cannot move '${src}': ${message}\n`;
        }
        exitCode = 1;
      }
    }

    return { stdout: '', stderr, exitCode };
  },
};
