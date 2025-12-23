import { Command, CommandContext, ExecResult } from '../../types.js';
import { unknownOption } from '../help.js';

export const uniqCommand: Command = {
  name: 'uniq',
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let count = false;
    let duplicatesOnly = false;
    let uniqueOnly = false;
    const files: string[] = [];

    // Parse arguments
    for (const arg of args) {
      if (arg === '-c' || arg === '--count') {
        count = true;
      } else if (arg === '-d' || arg === '--repeated') {
        duplicatesOnly = true;
      } else if (arg === '-u' || arg === '--unique') {
        uniqueOnly = true;
      } else if (arg.startsWith('--')) {
        return unknownOption('uniq', arg);
      } else if (arg.startsWith('-') && !arg.startsWith('--')) {
        // Handle combined flags like -cd
        for (const char of arg.slice(1)) {
          if (char === 'c') count = true;
          else if (char === 'd') duplicatesOnly = true;
          else if (char === 'u') uniqueOnly = true;
          else return unknownOption('uniq', `-${char}`);
        }
      } else {
        files.push(arg);
      }
    }

    let content = '';

    // Read from files or stdin
    if (files.length === 0) {
      content = ctx.stdin;
    } else {
      for (const file of files) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        try {
          content += await ctx.fs.readFile(filePath);
        } catch {
          return {
            stdout: '',
            stderr: `uniq: ${file}: No such file or directory\n`,
            exitCode: 1,
          };
        }
      }
    }

    // Split into lines
    let lines = content.split('\n');

    // Remove last empty element if content ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    if (lines.length === 0) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // Process adjacent duplicates
    const result: Array<{ line: string; count: number }> = [];
    let currentLine = lines[0];
    let currentCount = 1;

    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === currentLine) {
        currentCount++;
      } else {
        result.push({ line: currentLine, count: currentCount });
        currentLine = lines[i];
        currentCount = 1;
      }
    }
    result.push({ line: currentLine, count: currentCount });

    // Filter based on options
    let filtered = result;
    if (duplicatesOnly) {
      filtered = result.filter(r => r.count > 1);
    } else if (uniqueOnly) {
      filtered = result.filter(r => r.count === 1);
    }

    // Format output
    let output = '';
    for (const { line, count: c } of filtered) {
      if (count) {
        // Real bash right-justifies count in 4-char field followed by space
        output += `${String(c).padStart(4)} ${line}\n`;
      } else {
        output += line + '\n';
      }
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  },
};
