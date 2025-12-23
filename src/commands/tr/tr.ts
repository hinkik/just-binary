import { Command, CommandContext, ExecResult } from '../../types.js';
import { unknownOption } from '../help.js';

function expandRange(set: string): string {
  let result = '';
  let i = 0;

  while (i < set.length) {
    // Handle escape sequences
    if (set[i] === '\\' && i + 1 < set.length) {
      const next = set[i + 1];
      if (next === 'n') {
        result += '\n';
      } else if (next === 't') {
        result += '\t';
      } else if (next === 'r') {
        result += '\r';
      } else {
        result += next;
      }
      i += 2;
      continue;
    }

    // Handle character ranges like a-z
    if (i + 2 < set.length && set[i + 1] === '-') {
      const start = set.charCodeAt(i);
      const end = set.charCodeAt(i + 2);
      for (let code = start; code <= end; code++) {
        result += String.fromCharCode(code);
      }
      i += 3;
      continue;
    }

    result += set[i];
    i++;
  }

  return result;
}

export const trCommand: Command = {
  name: 'tr',
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let deleteMode = false;
    let squeezeMode = false;
    const sets: string[] = [];

    // Parse arguments
    for (const arg of args) {
      if (arg === '-d' || arg === '--delete') {
        deleteMode = true;
      } else if (arg === '-s' || arg === '--squeeze-repeats') {
        squeezeMode = true;
      } else if (arg.startsWith('--')) {
        return unknownOption('tr', arg);
      } else if (arg.startsWith('-') && arg.length > 1) {
        // Check for unknown short options
        for (const c of arg.slice(1)) {
          if (c !== 'd' && c !== 's') {
            return unknownOption('tr', `-${c}`);
          }
        }
        if (arg.includes('d')) deleteMode = true;
        if (arg.includes('s')) squeezeMode = true;
      } else if (!arg.startsWith('-')) {
        sets.push(arg);
      }
    }

    if (sets.length < 1) {
      return {
        stdout: '',
        stderr: 'tr: missing operand\n',
        exitCode: 1,
      };
    }

    if (!deleteMode && !squeezeMode && sets.length < 2) {
      return {
        stdout: '',
        stderr: 'tr: missing operand after SET1\n',
        exitCode: 1,
      };
    }

    const set1 = expandRange(sets[0]);
    const set2 = sets.length > 1 ? expandRange(sets[1]) : '';
    const content = ctx.stdin;

    let output = '';

    if (deleteMode) {
      // Delete characters in set1
      for (const char of content) {
        if (!set1.includes(char)) {
          output += char;
        }
      }
    } else if (squeezeMode && sets.length === 1) {
      // Squeeze consecutive characters in set1
      let prev = '';
      for (const char of content) {
        if (set1.includes(char) && char === prev) {
          continue; // Skip repeated character
        }
        output += char;
        prev = char;
      }
    } else {
      // Translate characters from set1 to set2
      const translationMap = new Map<string, string>();
      for (let i = 0; i < set1.length; i++) {
        // If set2 is shorter, use the last character of set2
        const targetChar = i < set2.length ? set2[i] : set2[set2.length - 1];
        translationMap.set(set1[i], targetChar);
      }

      for (const char of content) {
        output += translationMap.get(char) ?? char;
      }

      // If squeeze mode is also enabled, squeeze set2 characters
      if (squeezeMode) {
        let squeezed = '';
        let prev = '';
        for (const char of output) {
          if (set2.includes(char) && char === prev) {
            continue;
          }
          squeezed += char;
          prev = char;
        }
        output = squeezed;
      }
    }

    return { stdout: output, stderr: '', exitCode: 0 };
  },
};
