import { Command, CommandContext, ExecResult } from '../../types.js';

export const tailCommand: Command = {
  name: 'tail',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let lines = 10;
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
        stderr: 'tail: invalid number of lines\n',
        exitCode: 1,
      };
    }

    // If no files, read from stdin
    if (files.length === 0) {
      const inputLines = ctx.stdin.split('\n');
      // Handle trailing newline
      const effective = inputLines[inputLines.length - 1] === ''
        ? inputLines.slice(0, -1)
        : inputLines;
      let selected: string[];
      if (fromLine) {
        // +n means "start from line n" (1-indexed)
        selected = effective.slice(lines - 1);
      } else {
        selected = effective.slice(-lines);
      }
      const output = selected.join('\n');
      return {
        stdout: output + '\n',
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
        // Handle trailing newline
        const effective = contentLines[contentLines.length - 1] === ''
          ? contentLines.slice(0, -1)
          : contentLines;
        let selected: string[];
        if (fromLine) {
          // +n means "start from line n" (1-indexed)
          selected = effective.slice(lines - 1);
        } else {
          selected = effective.slice(-lines);
        }
        stdout += selected.join('\n') + '\n';
      } catch {
        stderr += `tail: ${file}: No such file or directory\n`;
        exitCode = 1;
      }
    }

    return { stdout, stderr, exitCode };
  },
};
