import { Command, CommandContext, ExecResult } from '../../types.js';
import { unknownOption } from '../help.js';

interface CutRange {
  start: number;
  end: number | null; // null means to end of line
}

function parseRange(spec: string): CutRange[] {
  const ranges: CutRange[] = [];
  const parts = spec.split(',');

  for (const part of parts) {
    if (part.includes('-')) {
      const [start, end] = part.split('-');
      ranges.push({
        start: start ? parseInt(start, 10) : 1,
        end: end ? parseInt(end, 10) : null,
      });
    } else {
      const num = parseInt(part, 10);
      ranges.push({ start: num, end: num });
    }
  }

  return ranges;
}

function extractByRanges(items: string[], ranges: CutRange[]): string[] {
  const result: string[] = [];

  for (const range of ranges) {
    const start = range.start - 1; // Convert to 0-indexed
    const end = range.end === null ? items.length : range.end;

    for (let i = start; i < end && i < items.length; i++) {
      if (i >= 0 && !result.includes(items[i])) {
        result.push(items[i]);
      }
    }
  }

  return result;
}

export const cutCommand: Command = {
  name: 'cut',
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let delimiter = '\t';
    let fieldSpec: string | null = null;
    let charSpec: string | null = null;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-d') {
        delimiter = args[++i] || '\t';
      } else if (arg.startsWith('-d')) {
        delimiter = arg.slice(2);
      } else if (arg === '-f') {
        fieldSpec = args[++i];
      } else if (arg.startsWith('-f')) {
        fieldSpec = arg.slice(2);
      } else if (arg === '-c') {
        charSpec = args[++i];
      } else if (arg.startsWith('-c')) {
        charSpec = arg.slice(2);
      } else if (arg.startsWith('--')) {
        return unknownOption('cut', arg);
      } else if (arg.startsWith('-')) {
        return unknownOption('cut', arg);
      } else {
        files.push(arg);
      }
    }

    if (!fieldSpec && !charSpec) {
      return {
        stdout: '',
        stderr: 'cut: you must specify a list of bytes, characters, or fields\n',
        exitCode: 1,
      };
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
            stderr: `cut: ${file}: No such file or directory\n`,
            exitCode: 1,
          };
        }
      }
    }

    // Split into lines
    let lines = content.split('\n');
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    const ranges = parseRange(fieldSpec || charSpec || '1');
    let output = '';

    for (const line of lines) {
      if (charSpec) {
        // Character mode
        const chars = line.split('');
        const selected: string[] = [];
        for (const range of ranges) {
          const start = range.start - 1;
          const end = range.end === null ? chars.length : range.end;
          for (let i = start; i < end && i < chars.length; i++) {
            if (i >= 0) {
              selected.push(chars[i]);
            }
          }
        }
        output += selected.join('') + '\n';
      } else {
        // Field mode
        const fields = line.split(delimiter);
        const selected = extractByRanges(fields, ranges);
        output += selected.join(delimiter) + '\n';
      }
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  },
};
