import { Command, CommandContext, ExecResult } from '../../types.js';
import { hasHelpFlag, showHelp, unknownOption } from '../help.js';

const tailHelp = {
  name: 'tail',
  summary: 'output the last part of files',
  usage: 'tail [OPTION]... [FILE]...',
  options: [
    '-c, --bytes=NUM    print the last NUM bytes',
    '-n, --lines=NUM    print the last NUM lines (default 10)',
    '-n +NUM            print starting from line NUM',
    '    --help         display this help and exit',
  ],
};

export const tailCommand: Command = {
  name: 'tail',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(tailHelp);
    }

    let lines = 10;
    let bytes: number | null = null;
    let fromLine = false; // true if +n syntax (start from line n)
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-n' && i + 1 < args.length) {
        const nextArg = args[++i];
        if (nextArg.startsWith('+')) {
          fromLine = true;
          lines = parseInt(nextArg.slice(1), 10);
        } else {
          lines = parseInt(nextArg, 10);
        }
      } else if (arg.startsWith('-n+')) {
        fromLine = true;
        lines = parseInt(arg.slice(3), 10);
      } else if (arg.startsWith('-n')) {
        lines = parseInt(arg.slice(2), 10);
      } else if (arg === '-c' && i + 1 < args.length) {
        bytes = parseInt(args[++i], 10);
      } else if (arg.startsWith('-c')) {
        bytes = parseInt(arg.slice(2), 10);
      } else if (arg.startsWith('--bytes=')) {
        bytes = parseInt(arg.slice(8), 10);
      } else if (arg.startsWith('--lines=')) {
        lines = parseInt(arg.slice(8), 10);
      } else if (arg.match(/^-\d+$/)) {
        lines = parseInt(arg.slice(1), 10);
      } else if (arg.startsWith('--')) {
        return unknownOption('tail', arg);
      } else if (arg.startsWith('-') && arg !== '-') {
        return unknownOption('tail', arg);
      } else {
        files.push(arg);
      }
    }

    if (bytes !== null && (isNaN(bytes) || bytes < 0)) {
      return {
        stdout: '',
        stderr: 'tail: invalid number of bytes\n',
        exitCode: 1,
      };
    }

    if (isNaN(lines) || lines < 0) {
      return {
        stdout: '',
        stderr: 'tail: invalid number of lines\n',
        exitCode: 1,
      };
    }

    // Helper to get tail of content
    const getTail = (content: string): string => {
      if (bytes !== null) {
        return content.slice(-bytes);
      }
      const contentLines = content.split('\n');
      const effective = contentLines[contentLines.length - 1] === ''
        ? contentLines.slice(0, -1)
        : contentLines;
      let selected: string[];
      if (fromLine) {
        selected = effective.slice(lines - 1);
      } else {
        selected = effective.slice(-lines);
      }
      return selected.join('\n') + '\n';
    };

    // If no files, read from stdin
    if (files.length === 0) {
      return {
        stdout: getTail(ctx.stdin),
        stderr: '',
        exitCode: 0,
      };
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];

      // Show header for multiple files
      if (files.length > 1) {
        if (i > 0) stdout += '\n';
        stdout += `==> ${file} <==\n`;
      }

      try {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        const content = await ctx.fs.readFile(filePath);
        stdout += getTail(content);
      } catch {
        stderr += `tail: ${file}: No such file or directory\n`;
        exitCode = 1;
      }
    }

    return { stdout, stderr, exitCode };
  },
};
