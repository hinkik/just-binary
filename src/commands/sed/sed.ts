import { Command, CommandContext, ExecResult } from '../../types.js';
import { unknownOption } from '../help.js';

interface SedCommand {
  type: 'substitute' | 'print' | 'delete';
  pattern?: string;
  replacement?: string;
  global?: boolean;
  ignoreCase?: boolean;
  lineStart?: number | '$';
  lineEnd?: number | '$';
  addressPattern?: string;
}

function parseSedScript(script: string): SedCommand | null {
  // Handle $ (last line) address + command: $p, $d
  const lastLineMatch = script.match(/^\$\s*([pd])$/);
  if (lastLineMatch) {
    const [, cmd] = lastLineMatch;
    return {
      type: cmd === 'p' ? 'print' : 'delete',
      lineStart: '$',
      lineEnd: '$',
    };
  }

  // Handle line address + command: 5p, 5,10p, 5d, /pattern/d
  const lineRangeMatch = script.match(/^(\d+)(?:,(\d+))?([pd])$/);
  if (lineRangeMatch) {
    const [, start, end, cmd] = lineRangeMatch;
    return {
      type: cmd === 'p' ? 'print' : 'delete',
      lineStart: parseInt(start, 10),
      lineEnd: end ? parseInt(end, 10) : parseInt(start, 10),
    };
  }

  // Handle pattern address + delete: /pattern/d
  const patternDeleteMatch = script.match(/^\/(.+)\/d$/);
  if (patternDeleteMatch) {
    return {
      type: 'delete',
      addressPattern: patternDeleteMatch[1],
    };
  }

  // Handle address + substitution: 1s/pattern/replacement/, 2,4s/pattern/replacement/, $s/pattern/replacement/
  const addressSubMatch = script.match(/^(\d+|\$)(?:,(\d+|\$))?\s*s(.)(.+?)\3(.*?)\3([gi]*)$/);
  if (addressSubMatch) {
    const [, start, end, , pattern, replacement, flags] = addressSubMatch;
    return {
      type: 'substitute',
      pattern,
      replacement,
      global: flags.includes('g'),
      ignoreCase: flags.includes('i'),
      lineStart: start === '$' ? '$' : parseInt(start, 10),
      lineEnd: end ? (end === '$' ? '$' : parseInt(end, 10)) : (start === '$' ? '$' : parseInt(start, 10)),
    };
  }

  // Handle substitution: s/pattern/replacement/ or s/pattern/replacement/g or s/pattern/replacement/gi
  const subMatch = script.match(/^s(.)(.+?)\1(.*?)\1([gi]*)$/);
  if (subMatch) {
    const [, , pattern, replacement, flags] = subMatch;
    return {
      type: 'substitute',
      pattern,
      replacement,
      global: flags.includes('g'),
      ignoreCase: flags.includes('i'),
    };
  }

  return null;
}

function processReplacement(replacement: string, match: string): string {
  // Handle & (matched text) and \& (literal &)
  let result = '';
  let i = 0;
  while (i < replacement.length) {
    if (replacement[i] === '\\' && i + 1 < replacement.length) {
      if (replacement[i + 1] === '&') {
        result += '&';
        i += 2;
        continue;
      }
    }
    if (replacement[i] === '&') {
      result += match;
    } else {
      result += replacement[i];
    }
    i++;
  }
  return result;
}

export const sedCommand: Command = {
  name: 'sed',
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    const scripts: string[] = [];
    let silent = false;
    let inPlace = false;
    const files: string[] = [];

    // Parse arguments
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-n' || arg === '--quiet' || arg === '--silent') {
        silent = true;
      } else if (arg === '-i' || arg === '--in-place') {
        inPlace = true;
      } else if (arg.startsWith('-i')) {
        // Handle -i with optional suffix (we ignore suffix for now)
        inPlace = true;
      } else if (arg === '-e') {
        if (i + 1 < args.length) {
          scripts.push(args[++i]);
        }
      } else if (arg.startsWith('--')) {
        return unknownOption('sed', arg);
      } else if (arg.startsWith('-') && arg.length > 1) {
        // Check for unknown short options
        for (const c of arg.slice(1)) {
          if (c !== 'n' && c !== 'e' && c !== 'i') {
            return unknownOption('sed', `-${c}`);
          }
        }
        // Handle combined flags like -ne
        if (arg.includes('n')) silent = true;
        if (arg.includes('i')) inPlace = true;
        // -e in combined form would need next arg for script, handle separately
        if (arg.includes('e') && !arg.includes('n') && !arg.includes('i')) {
          if (i + 1 < args.length) {
            scripts.push(args[++i]);
          }
        }
      } else if (!arg.startsWith('-') && scripts.length === 0) {
        scripts.push(arg);
      } else if (!arg.startsWith('-')) {
        files.push(arg);
      }
    }

    if (scripts.length === 0) {
      return {
        stdout: '',
        stderr: 'sed: no script specified\n',
        exitCode: 1,
      };
    }

    const sedCmds: SedCommand[] = [];
    for (const script of scripts) {
      const sedCmd = parseSedScript(script);
      if (!sedCmd) {
        return {
          stdout: '',
          stderr: `sed: invalid script: ${script}\n`,
          exitCode: 1,
        };
      }
      sedCmds.push(sedCmd);
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
            stderr: `sed: ${file}: No such file or directory\n`,
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

    const totalLines = lines.length;

    // Apply all sed commands to each line
    let output = '';

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const lineNum = lineIndex + 1;
      let line = lines[lineIndex];
      let deleted = false;
      let printed = false;

      for (const sedCmd of sedCmds) {
        if (deleted) break;

        // Resolve $ to actual last line number
        const resolveAddress = (addr: number | '$' | undefined): number | undefined => {
          if (addr === '$') return totalLines;
          return addr;
        };

        const lineStart = resolveAddress(sedCmd.lineStart);
        const lineEnd = resolveAddress(sedCmd.lineEnd);

        // Check if this line is in the address range (if specified)
        const inRange = lineStart === undefined ||
          (lineNum >= lineStart && lineNum <= (lineEnd ?? lineStart));

        if (sedCmd.type === 'substitute' && inRange) {
          let flags = '';
          if (sedCmd.global) flags += 'g';
          if (sedCmd.ignoreCase) flags += 'i';
          const regex = new RegExp(sedCmd.pattern!, flags);

          // Handle & replacement
          line = line.replace(regex, (match) => processReplacement(sedCmd.replacement!, match));
        } else if (sedCmd.type === 'delete') {
          if (sedCmd.addressPattern) {
            const regex = new RegExp(sedCmd.addressPattern);
            if (regex.test(line)) {
              deleted = true;
            }
          } else if (inRange && lineStart !== undefined) {
            deleted = true;
          }
        } else if (sedCmd.type === 'print' && inRange && lineStart !== undefined) {
          printed = true;
        }
      }

      if (!deleted) {
        if (silent) {
          if (printed) {
            output += line + '\n';
          }
        } else {
          output += line + '\n';
        }
      }
    }

    // Handle in-place editing
    if (inPlace && files.length > 0) {
      for (const file of files) {
        const filePath = ctx.fs.resolvePath(ctx.cwd, file);
        // Re-process this specific file for in-place editing
        let fileContent = '';
        try {
          fileContent = await ctx.fs.readFile(filePath);
        } catch {
          return {
            stdout: '',
            stderr: `sed: ${file}: No such file or directory\n`,
            exitCode: 1,
          };
        }

        let fileLines = fileContent.split('\n');
        if (fileLines.length > 0 && fileLines[fileLines.length - 1] === '') {
          fileLines.pop();
        }

        const fileTotalLines = fileLines.length;
        let fileOutput = '';

        for (let lineIndex = 0; lineIndex < fileLines.length; lineIndex++) {
          const lineNum = lineIndex + 1;
          let line = fileLines[lineIndex];
          let deleted = false;
          let printed = false;

          for (const sedCmd of sedCmds) {
            if (deleted) break;

            const resolveAddress = (addr: number | '$' | undefined): number | undefined => {
              if (addr === '$') return fileTotalLines;
              return addr;
            };

            const lineStart = resolveAddress(sedCmd.lineStart);
            const lineEnd = resolveAddress(sedCmd.lineEnd);

            const inRange = lineStart === undefined ||
              (lineNum >= lineStart && lineNum <= (lineEnd ?? lineStart));

            if (sedCmd.type === 'substitute' && inRange) {
              let flags = '';
              if (sedCmd.global) flags += 'g';
              if (sedCmd.ignoreCase) flags += 'i';
              const regex = new RegExp(sedCmd.pattern!, flags);
              line = line.replace(regex, (match) => processReplacement(sedCmd.replacement!, match));
            } else if (sedCmd.type === 'delete') {
              if (sedCmd.addressPattern) {
                const regex = new RegExp(sedCmd.addressPattern);
                if (regex.test(line)) {
                  deleted = true;
                }
              } else if (inRange && lineStart !== undefined) {
                deleted = true;
              }
            } else if (sedCmd.type === 'print' && inRange && lineStart !== undefined) {
              printed = true;
            }
          }

          if (!deleted) {
            if (silent) {
              if (printed) {
                fileOutput += line + '\n';
              }
            } else {
              fileOutput += line + '\n';
            }
          }
        }

        // Write back to file
        await ctx.fs.writeFile(filePath, fileOutput);
      }
      // In-place mode produces no stdout
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  },
};
