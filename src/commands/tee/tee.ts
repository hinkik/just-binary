import { Command, CommandContext, ExecResult } from '../../types.js';
import { hasHelpFlag, showHelp, unknownOption } from '../help.js';

const teeHelp = {
  name: 'tee',
  summary: 'read from stdin and write to stdout and files',
  usage: 'tee [OPTION]... [FILE]...',
  options: [
    '-a, --append     append to the given FILEs, do not overwrite',
    '    --help       display this help and exit',
  ],
};

export const teeCommand: Command = {
  name: 'tee',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(teeHelp);
    }

    let append = false;
    const files: string[] = [];

    for (const arg of args) {
      if (arg === '-a' || arg === '--append') {
        append = true;
      } else if (arg.startsWith('--')) {
        return unknownOption('tee', arg);
      } else if (arg.startsWith('-') && arg.length > 1) {
        for (const c of arg.slice(1)) {
          if (c === 'a') append = true;
          else return unknownOption('tee', `-${c}`);
        }
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    const content = ctx.stdin;
    let stderr = '';
    let exitCode = 0;

    // Write to each file
    for (const file of files) {
      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        if (append) {
          await ctx.fs.appendFile(filePath, content);
        } else {
          await ctx.fs.writeFile(filePath, content);
        }
      } catch (error) {
        stderr += `tee: ${file}: No such file or directory\n`;
        exitCode = 1;
      }
    }

    // Pass through to stdout
    return {
      stdout: content,
      stderr,
      exitCode,
    };
  },
};
