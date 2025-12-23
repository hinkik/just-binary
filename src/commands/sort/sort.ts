import { Command, CommandContext, ExecResult } from '../../types.js';
import { unknownOption } from '../help.js';

export const sortCommand: Command = {
  name: 'sort',
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let reverse = false;
    let numeric = false;
    let unique = false;
    let keyField: number | null = null;
    let fieldDelimiter: string | null = null;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-r' || arg === '--reverse') {
        reverse = true;
      } else if (arg === '-n' || arg === '--numeric-sort') {
        numeric = true;
      } else if (arg === '-u' || arg === '--unique') {
        unique = true;
      } else if (arg === '-t' || arg === '--field-separator') {
        fieldDelimiter = args[++i] || null;
      } else if (arg.startsWith('-t')) {
        fieldDelimiter = arg.slice(2) || null;
      } else if (arg === '-k' || arg === '--key') {
        const keyArg = args[++i];
        if (keyArg) {
          const keyNum = parseInt(keyArg, 10);
          if (!isNaN(keyNum) && keyNum >= 1) {
            keyField = keyNum;
          }
        }
      } else if (arg.startsWith('-k')) {
        const keyNum = parseInt(arg.slice(2), 10);
        if (!isNaN(keyNum) && keyNum >= 1) {
          keyField = keyNum;
        }
      } else if (arg.startsWith('--')) {
        return unknownOption('sort', arg);
      } else if (arg.startsWith('-') && !arg.startsWith('--')) {
        // Handle combined flags like -rn
        for (const char of arg.slice(1)) {
          if (char === 'r') reverse = true;
          else if (char === 'n') numeric = true;
          else if (char === 'u') unique = true;
          else return unknownOption('sort', `-${char}`);
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
            stderr: `sort: ${file}: No such file or directory\n`,
            exitCode: 1,
          };
        }
      }
    }

    // Split into lines (preserve empty lines at the end for sorting)
    let lines = content.split('\n');

    // Remove last empty element if content ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    // Sort lines
    lines.sort((a, b) => {
      let valA = a;
      let valB = b;

      // Extract key field if specified
      if (keyField !== null) {
        const splitPattern = fieldDelimiter !== null ? fieldDelimiter : /\s+/;
        const partsA = a.split(splitPattern);
        const partsB = b.split(splitPattern);
        valA = partsA[keyField - 1] || '';
        valB = partsB[keyField - 1] || '';
      }

      if (numeric) {
        const numA = parseFloat(valA) || 0;
        const numB = parseFloat(valB) || 0;
        return numA - numB;
      }

      return valA.localeCompare(valB);
    });

    if (reverse) {
      lines.reverse();
    }

    // Remove duplicates if -u
    if (unique) {
      lines = [...new Set(lines)];
    }

    const output = lines.length > 0 ? lines.join('\n') + '\n' : '';
    return { stdout: output, stderr: '', exitCode: 0 };
  },
};
