import { Command, CommandContext, ExecResult } from '../../types.js';

export const headCommand: Command = {
  name: 'head',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let lines = 10;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-n' && i + 1 < args.length) {
        lines = parseInt(args[++i], 10);
      } else if (arg.startsWith('-n')) {
        lines = parseInt(arg.slice(2), 10);
      } else if (arg.match(/^-\d+$/)) {
        lines = parseInt(arg.slice(1), 10);
      } else if (arg.startsWith('-')) {
        // Ignore other flags
      } else {
        files.push(arg);
      }
    }

    if (isNaN(lines) || lines < 0) {
      return {
        stdout: '',
        stderr: 'head: invalid number of lines\n',
        exitCode: 1,
      };
    }

    // If no files, read from stdin
    if (files.length === 0) {
      let inputLines = ctx.stdin.split('\n');
      // Remove trailing empty line from split if input ended with newline
      const hadTrailingNewline = ctx.stdin.endsWith('\n');
      if (hadTrailingNewline && inputLines.length > 0 && inputLines[inputLines.length - 1] === '') {
        inputLines = inputLines.slice(0, -1);
      }
      const selected = inputLines.slice(0, lines);
      const output = selected.join('\n');
      return {
        stdout: output + (output ? '\n' : ''),
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
        const contentLines = content.split('\n');
        const selected = contentLines.slice(0, lines);
        stdout += selected.join('\n');
        if (selected.length < contentLines.length || content.endsWith('\n')) {
          if (!stdout.endsWith('\n')) stdout += '\n';
        }
      } catch {
        stderr += `head: ${file}: No such file or directory\n`;
        exitCode = 1;
      }
    }

    return { stdout, stderr, exitCode };
  },
};
