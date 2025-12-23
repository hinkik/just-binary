import { Command, CommandContext, ExecResult } from '../../types.js';
import { hasHelpFlag, showHelp, unknownOption } from '../help.js';

const headHelp = {
  name: 'head',
  summary: 'output the first part of files',
  usage: 'head [OPTION]... [FILE]...',
  options: [
    '-c, --bytes=NUM    print the first NUM bytes',
    '-n, --lines=NUM    print the first NUM lines (default 10)',
    '    --help         display this help and exit',
  ],
};

export const headCommand: Command = {
  name: 'head',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(headHelp);
    }

    let lines = 10;
    let bytes: number | null = null;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-n' && i + 1 < args.length) {
        lines = parseInt(args[++i], 10);
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
        return unknownOption('head', arg);
      } else if (arg.startsWith('-') && arg !== '-') {
        return unknownOption('head', arg);
      } else {
        files.push(arg);
      }
    }

    if (bytes !== null && (isNaN(bytes) || bytes < 0)) {
      return {
        stdout: '',
        stderr: 'head: invalid number of bytes\n',
        exitCode: 1,
      };
    }

    if (isNaN(lines) || lines < 0) {
      return {
        stdout: '',
        stderr: 'head: invalid number of lines\n',
        exitCode: 1,
      };
    }

    // Helper to get head of content
    const getHead = (content: string): string => {
      if (bytes !== null) {
        return content.slice(0, bytes);
      }
      let inputLines = content.split('\n');
      const hadTrailingNewline = content.endsWith('\n');
      if (hadTrailingNewline && inputLines.length > 0 && inputLines[inputLines.length - 1] === '') {
        inputLines = inputLines.slice(0, -1);
      }
      const selected = inputLines.slice(0, lines);
      const output = selected.join('\n');
      return output + (output ? '\n' : '');
    };

    // If no files, read from stdin
    if (files.length === 0) {
      return {
        stdout: getHead(ctx.stdin),
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
        stdout += getHead(content);
      } catch {
        stderr += `head: ${file}: No such file or directory\n`;
        exitCode = 1;
      }
    }

    return { stdout, stderr, exitCode };
  },
};
