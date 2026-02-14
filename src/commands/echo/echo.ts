import type { Command, CommandContext, ExecResult } from "../../types.js";
import { concat, decodeArgs, EMPTY, encode } from "../../utils/bytes.js";

const te = new TextEncoder();

/** Push bytes from a Uint8Array into a number array */
function pushBytes(arr: number[], bytes: Uint8Array): void {
  for (let k = 0; k < bytes.length; k++) {
    arr.push(bytes[k]);
  }
}

/**
 * Process echo -e escape sequences, producing Uint8Array output directly.
 * \xHH and \0NNN push raw bytes; \uHHHH/\UHHHHHHHH push UTF-8 encoded bytes;
 * regular characters are UTF-8 encoded.
 */
function processEscapes(input: string): { output: Uint8Array; stop: boolean } {
  const bytes: number[] = [];
  let i = 0;

  while (i < input.length) {
    if (input[i] === "\\") {
      if (i + 1 >= input.length) {
        bytes.push(0x5c); // backslash
        break;
      }

      const next = input[i + 1];

      switch (next) {
        case "\\":
          bytes.push(0x5c);
          i += 2;
          break;
        case "n":
          bytes.push(0x0a);
          i += 2;
          break;
        case "t":
          bytes.push(0x09);
          i += 2;
          break;
        case "r":
          bytes.push(0x0d);
          i += 2;
          break;
        case "a":
          bytes.push(0x07);
          i += 2;
          break;
        case "b":
          bytes.push(0x08);
          i += 2;
          break;
        case "f":
          bytes.push(0x0c);
          i += 2;
          break;
        case "v":
          bytes.push(0x0b);
          i += 2;
          break;
        case "e":
        case "E":
          bytes.push(0x1b);
          i += 2;
          break;
        case "c":
          // \c stops output and suppresses trailing newline
          return { output: new Uint8Array(bytes), stop: true };
        case "0": {
          // \0NNN - octal (up to 3 digits after the 0)
          let octal = "";
          let j = i + 2;
          while (j < input.length && j < i + 5 && /[0-7]/.test(input[j])) {
            octal += input[j];
            j++;
          }
          if (octal.length === 0) {
            // \0 alone is NUL
            bytes.push(0x00);
          } else {
            bytes.push(parseInt(octal, 8) % 256);
          }
          i = j;
          break;
        }
        case "x": {
          // \xHH - hex (1-2 hex digits) - push raw byte
          let hex = "";
          let j = i + 2;
          while (
            j < input.length &&
            j < i + 4 &&
            /[0-9a-fA-F]/.test(input[j])
          ) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            // \x with no valid hex digits - output literally
            bytes.push(0x5c, 0x78); // \x
            i += 2;
          } else {
            bytes.push(parseInt(hex, 16));
            i = j;
          }
          break;
        }
        case "u": {
          // \uHHHH - 4-digit unicode -> UTF-8 encoded
          let hex = "";
          let j = i + 2;
          while (
            j < input.length &&
            j < i + 6 &&
            /[0-9a-fA-F]/.test(input[j])
          ) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            pushBytes(bytes, te.encode("\\u"));
            i += 2;
          } else {
            const code = parseInt(hex, 16);
            pushBytes(bytes, te.encode(String.fromCodePoint(code)));
            i = j;
          }
          break;
        }
        case "U": {
          // \UHHHHHHHH - 8-digit unicode -> UTF-8 encoded
          let hex = "";
          let j = i + 2;
          while (
            j < input.length &&
            j < i + 10 &&
            /[0-9a-fA-F]/.test(input[j])
          ) {
            hex += input[j];
            j++;
          }
          if (hex.length === 0) {
            pushBytes(bytes, te.encode("\\U"));
            i += 2;
          } else {
            const code = parseInt(hex, 16);
            try {
              pushBytes(bytes, te.encode(String.fromCodePoint(code)));
            } catch {
              // Invalid code point, output as-is
              pushBytes(bytes, te.encode(`\\U${hex}`));
            }
            i = j;
          }
          break;
        }
        default:
          // Unknown escape - keep the backslash and character
          pushBytes(bytes, te.encode(`\\${next}`));
          i += 2;
      }
    } else {
      // Regular character - UTF-8 encode
      // Fast path for ASCII
      const code = input.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
        i++;
      } else {
        // Handle multi-byte characters (including surrogate pairs)
        const char =
          code >= 0xd800 && code <= 0xdbff && i + 1 < input.length
            ? input.slice(i, i + 2)
            : input[i];
        pushBytes(bytes, te.encode(char));
        i += char.length;
      }
    }
  }

  return { output: new Uint8Array(bytes), stop: false };
}

export const echoCommand: Command = {
  name: "echo",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    let noNewline = false;
    // When xpg_echo is enabled, interpret escapes by default (like echo -e)
    let interpretEscapes = ctx.xpgEcho ?? false;
    let startIndex = 0;

    // Parse flags
    while (startIndex < a.length) {
      const arg = a[startIndex];
      if (arg === "-n") {
        noNewline = true;
        startIndex++;
      } else if (arg === "-e") {
        interpretEscapes = true;
        startIndex++;
      } else if (arg === "-E") {
        interpretEscapes = false;
        startIndex++;
      } else if (arg === "-ne" || arg === "-en") {
        noNewline = true;
        interpretEscapes = true;
        startIndex++;
      } else {
        break;
      }
    }

    const outputStr = a.slice(startIndex).join(" ");

    if (interpretEscapes) {
      const result = processEscapes(outputStr);
      if (result.stop) {
        // \c encountered - suppress newline and stop
        return {
          stdout: result.output,
          stderr: EMPTY,
          exitCode: 0,
        };
      }
      return {
        stdout: noNewline
          ? result.output
          : concat(result.output, new Uint8Array([0x0a])),
        stderr: EMPTY,
        exitCode: 0,
      };
    }

    return {
      stdout: encode(noNewline ? outputStr : `${outputStr}\n`),
      stderr: EMPTY,
      exitCode: 0,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "echo",
  flags: [
    { flag: "-n", type: "boolean" },
    { flag: "-e", type: "boolean" },
    { flag: "-E", type: "boolean" },
  ],
  stdinType: "none",
  needsArgs: true,
};
