import { Command, CommandContext, ExecResult } from '../../types.js';

export const catCommand: Command = {
  name: 'cat',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let showLineNumbers = false;
    const files: string[] = [];

    // Parse arguments
    for (const arg of args) {
      if (arg === '-n') {
        showLineNumbers = true;
      } else if (arg === '-') {
        // '-' means read from stdin
        files.push('-');
      } else if (arg.startsWith('-')) {
        // Ignore other flags for now
      } else {
        files.push(arg);
      }
    }

    // If no files specified, read from stdin
    if (files.length === 0) {
      let output = ctx.stdin;
      if (showLineNumbers && output) {
        output = addLineNumbers(output);
      }
      return { stdout: output, stderr: '', exitCode: 0 };
    }

    let stdout = '';
    let stderr = '';
    let exitCode = 0;

    for (const file of files) {
      try {
        let content: string;
        if (file === '-') {
          content = ctx.stdin;
        } else {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          content = await ctx.fs.readFile(filePath);
        }

        if (showLineNumbers) {
          // Real bash restarts line numbers for each file
          content = addLineNumbers(content);
        }

        stdout += content;
      } catch (error) {
        stderr += `cat: ${file}: No such file or directory\n`;
        exitCode = 1;
      }
    }

    return { stdout, stderr, exitCode };
  },
};

function addLineNumbers(content: string): string {
  const lines = content.split('\n');
  // Don't number the trailing empty line if file ends with newline
  const hasTrailingNewline = content.endsWith('\n');
  const linesToNumber = hasTrailingNewline ? lines.slice(0, -1) : lines;

  const numbered = linesToNumber.map((line, i) => {
    const num = String(i + 1).padStart(6, ' ');
    return `${num}\t${line}`;
  });

  return numbered.join('\n') + (hasTrailingNewline ? '\n' : '');
}
