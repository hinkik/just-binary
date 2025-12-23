import { sprintf } from 'sprintf-js';
import { Command, CommandContext, ExecResult } from '../../types.js';
import { hasHelpFlag, showHelp } from '../help.js';

const printfHelp = {
  name: 'printf',
  summary: 'format and print data',
  usage: 'printf FORMAT [ARGUMENT...]',
  options: [
    '    --help     display this help and exit',
  ],
  notes: [
    'FORMAT controls the output like in C printf.',
    'Escape sequences: \\n (newline), \\t (tab), \\\\ (backslash)',
    'Format specifiers: %s (string), %d (integer), %f (float), %x (hex), %o (octal), %% (literal %)',
    'Width and precision: %10s (width 10), %.2f (2 decimal places), %010d (zero-padded)',
    'Flags: %- (left-justify), %+ (show sign), %0 (zero-pad)',
  ],
};

export const printfCommand: Command = {
  name: 'printf',

  async execute(args: string[], _ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(printfHelp);
    }

    if (args.length === 0) {
      return { stdout: '', stderr: 'printf: usage: printf format [arguments]\n', exitCode: 1 };
    }

    const format = args[0];
    const formatArgs = args.slice(1);

    try {
      // First, process escape sequences in the format string
      const processedFormat = processEscapes(format);

      // Convert arguments to appropriate types based on format specifiers
      const typedArgs = convertArgs(processedFormat, formatArgs);

      // Use sprintf-js for formatting
      const output = sprintf(processedFormat, ...typedArgs);

      return { stdout: output, stderr: '', exitCode: 0 };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: `printf: ${message}\n`, exitCode: 1 };
    }
  },
};

/**
 * Process escape sequences in the format string
 */
function processEscapes(str: string): string {
  let result = '';
  let i = 0;

  while (i < str.length) {
    if (str[i] === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      switch (next) {
        case 'n':
          result += '\n';
          i += 2;
          break;
        case 't':
          result += '\t';
          i += 2;
          break;
        case 'r':
          result += '\r';
          i += 2;
          break;
        case '\\':
          result += '\\';
          i += 2;
          break;
        case 'a':
          result += '\x07';
          i += 2;
          break;
        case 'b':
          result += '\b';
          i += 2;
          break;
        case 'f':
          result += '\f';
          i += 2;
          break;
        case 'v':
          result += '\v';
          i += 2;
          break;
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
          // Octal escape sequence
          let octal = '';
          let j = i + 1;
          while (j < str.length && j < i + 4 && /[0-7]/.test(str[j])) {
            octal += str[j];
            j++;
          }
          result += String.fromCharCode(parseInt(octal, 8));
          i = j;
          break;
        case 'x':
          // Hex escape sequence
          if (i + 3 < str.length && /[0-9a-fA-F]{2}/.test(str.slice(i + 2, i + 4))) {
            result += String.fromCharCode(parseInt(str.slice(i + 2, i + 4), 16));
            i += 4;
          } else {
            result += str[i];
            i++;
          }
          break;
        default:
          result += str[i];
          i++;
      }
    } else {
      result += str[i];
      i++;
    }
  }

  return result;
}

/**
 * Convert string arguments to appropriate types based on format specifiers
 */
function convertArgs(format: string, args: string[]): (string | number)[] {
  const result: (string | number)[] = [];
  let argIndex = 0;

  // Match format specifiers: %[flags][width][.precision][length]specifier
  const specifierRegex = /%[-+0 #]*\d*(?:\.\d+)?[hlL]?([diouxXeEfFgGaAcspn%])/g;
  let match;

  while ((match = specifierRegex.exec(format)) !== null) {
    const specifier = match[1];

    if (specifier === '%') {
      // %% doesn't consume an argument
      continue;
    }

    const arg = args[argIndex] || '';
    argIndex++;

    switch (specifier) {
      case 'd':
      case 'i':
      case 'o':
      case 'u':
      case 'x':
      case 'X':
        // Integer types
        result.push(parseInt(arg, 10) || 0);
        break;
      case 'e':
      case 'E':
      case 'f':
      case 'F':
      case 'g':
      case 'G':
      case 'a':
      case 'A':
        // Float types
        result.push(parseFloat(arg) || 0);
        break;
      case 'c':
        // Character - take first char
        result.push(arg.charAt(0) || '');
        break;
      case 's':
      default:
        // String
        result.push(arg);
        break;
    }
  }

  return result;
}
