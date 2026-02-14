import { sprintf } from "sprintf-js";
import { ExecutionLimitError } from "../../interpreter/errors.js";
import { getErrorMessage } from "../../interpreter/helpers/errors.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import {
  concat,
  decodeArgs,
  EMPTY,
  encode,
  envGet,
  envSet,
} from "../../utils/bytes.js";
import { hasHelpFlag, showHelp } from "../help.js";
import { applyWidth, processEscapesBytes } from "./escapes.js";
import { formatStrftime } from "./strftime.js";

const te = new TextEncoder();

/** Push bytes from a Uint8Array into a number array */
function pushBytes(arr: number[], bytes: Uint8Array): void {
  for (let k = 0; k < bytes.length; k++) {
    arr.push(bytes[k]);
  }
}

/** Encode a string segment and push into byte array */
function pushStr(arr: number[], s: string): void {
  pushBytes(arr, te.encode(s));
}

const printfHelp = {
  name: "printf",
  summary: "format and print data",
  usage: "printf [-v var] FORMAT [ARGUMENT...]",
  options: [
    "    -v var     assign the output to shell variable VAR rather than display it",
    "    --help     display this help and exit",
  ],
  notes: [
    "FORMAT controls the output like in C printf.",
    "Escape sequences: \\n (newline), \\t (tab), \\\\ (backslash)",
    "Format specifiers: %s (string), %d (integer), %f (float), %x (hex), %o (octal), %% (literal %)",
    "Width and precision: %10s (width 10), %.2f (2 decimal places), %010d (zero-padded)",
    "Flags: %- (left-justify), %+ (show sign), %0 (zero-pad)",
  ],
};

export const printfCommand: Command = {
  name: "printf",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(printfHelp);
    }

    if (a.length === 0) {
      return {
        stdout: EMPTY,
        stderr: encode("printf: usage: printf format [arguments]\n"),
        exitCode: 2,
      };
    }

    // Parse options
    let targetVar: string | null = null;
    let argIndex = 0;

    while (argIndex < a.length) {
      const arg = a[argIndex];
      if (arg === "--") {
        // End of options
        argIndex++;
        break;
      }
      if (arg === "-v") {
        // Store result in variable
        if (argIndex + 1 >= a.length) {
          return {
            stdout: EMPTY,
            stderr: encode("printf: -v: option requires an argument\n"),
            exitCode: 1,
          };
        }
        targetVar = a[argIndex + 1];
        // Validate variable name
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*(\[[^\]]+\])?$/.test(targetVar)) {
          return {
            stdout: EMPTY,
            stderr: encode(`printf: \`${targetVar}': not a valid identifier\n`),
            exitCode: 2,
          };
        }
        argIndex += 2;
      } else if (arg.startsWith("-") && arg !== "-") {
        // Unknown option - treat as format string (bash behavior)
        break;
      } else {
        break;
      }
    }

    if (argIndex >= a.length) {
      return {
        stdout: EMPTY,
        stderr: encode("printf: usage: printf format [arguments]\n"),
        exitCode: 1,
      };
    }

    const format = a[argIndex];
    const formatArgs = a.slice(argIndex + 1);

    try {
      // First, process escape sequences in the format string into bytes
      const processedFormat = processEscapesBytes(format);

      // Format and handle argument reuse (bash loops through format until all args consumed)
      let output = EMPTY;
      let argPos = 0;
      let hadError = false;
      let errorMessage = "";

      // Get TZ from shell environment for strftime formatting
      const tz = envGet(ctx.env, "TZ") || undefined;

      const maxStringLength = ctx.limits?.maxStringLength;

      do {
        const { result, argsConsumed, error, errMsg, stopped } = formatOnce(
          processedFormat,
          formatArgs,
          argPos,
          tz,
        );
        output = concat(output, result);
        // Check output size against limit
        if (
          maxStringLength !== undefined &&
          maxStringLength > 0 &&
          output.length > maxStringLength
        ) {
          throw new ExecutionLimitError(
            `printf: output size limit exceeded (${maxStringLength} bytes)`,
            "string_length",
          );
        }
        argPos += argsConsumed;
        if (error) {
          hadError = true;
          if (errMsg) errorMessage = errMsg;
        }
        // If %b with \c was encountered, stop all output immediately
        if (stopped) {
          break;
        }
      } while (argPos < formatArgs.length && argPos > 0);

      // If no args were consumed but format had no specifiers, just output format
      if (argPos === 0 && formatArgs.length > 0) {
        // Format had no specifiers - output once
      }

      // If -v was specified, store in variable instead of printing
      if (targetVar) {
        // For -v, decode the byte output back to a string for variable storage
        const outputStr = new TextDecoder().decode(output);
        // Check for array subscript syntax: name[key] or name["key"] or name['key']
        const arrayMatch = targetVar.match(
          /^([a-zA-Z_][a-zA-Z0-9_]*)\[(['"]?)(.+?)\2\]$/,
        );
        if (arrayMatch) {
          const arrayName = arrayMatch[1];
          let key = arrayMatch[3];
          // Expand variables in the subscript (e.g., $key -> value)
          key = key.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, varName) => {
            return envGet(ctx.env, varName);
          });
          envSet(ctx.env, `${arrayName}_${key}`, outputStr);
        } else {
          envSet(ctx.env, targetVar, outputStr);
        }
        return {
          stdout: EMPTY,
          stderr: encode(errorMessage),
          exitCode: hadError ? 1 : 0,
        };
      }

      return {
        stdout: output,
        stderr: encode(errorMessage),
        exitCode: hadError ? 1 : 0,
      };
    } catch (error) {
      if (error instanceof ExecutionLimitError) {
        throw error;
      }
      return {
        stdout: EMPTY,
        stderr: encode(`printf: ${getErrorMessage(error)}\n`),
        exitCode: 1,
      };
    }
  },
};

/** Helper: decode a single ASCII char from byte */
function charFromByte(b: number): string {
  return String.fromCharCode(b);
}

/** Helper: test if byte is an ASCII digit */
function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39; // '0'-'9'
}

/**
 * Format the string once, consuming args starting at argPos.
 * The format is a Uint8Array (already escape-processed).
 * Returns the formatted result as Uint8Array and number of args consumed.
 */
function formatOnce(
  format: Uint8Array,
  args: string[],
  argPos: number,
  tz?: string,
): {
  result: Uint8Array;
  argsConsumed: number;
  error: boolean;
  errMsg: string;
  stopped: boolean;
} {
  const bytes: number[] = [];
  let i = 0;
  let argsConsumed = 0;
  let error = false;
  let errMsg = "";

  while (i < format.length) {
    if (format[i] === 0x25 /* % */ && i + 1 < format.length) {
      // Parse the format specifier
      const specStart = i;
      i++; // skip %

      // Check for %%
      if (format[i] === 0x25 /* % */) {
        bytes.push(0x25); // %
        i++;
        continue;
      }

      // Check for %(strftime)T format
      // We need to decode a slice of the format to use regex matching
      const formatSlice = new TextDecoder().decode(format.subarray(specStart));
      const strftimeMatch = formatSlice.match(
        /^%(-?\d*)(?:\.(\d+))?\(([^)]*)\)T/,
      );
      if (strftimeMatch) {
        const width = strftimeMatch[1] ? parseInt(strftimeMatch[1], 10) : 0;
        const precision = strftimeMatch[2]
          ? parseInt(strftimeMatch[2], 10)
          : -1;
        const strftimeFmt = strftimeMatch[3];
        // Calculate byte length of the match
        const fullMatchBytes = te.encode(strftimeMatch[0]);

        // Get the timestamp argument
        const arg = args[argPos + argsConsumed] || "";
        argsConsumed++;

        // Parse timestamp - empty or -1 means current time, -2 means shell start time
        let timestamp: number;
        if (arg === "" || arg === "-1") {
          timestamp = Math.floor(Date.now() / 1000);
        } else if (arg === "-2") {
          // Shell start time - use current time as approximation
          timestamp = Math.floor(Date.now() / 1000);
        } else {
          timestamp = parseInt(arg, 10) || 0;
        }

        // Format using strftime
        let formatted = formatStrftime(strftimeFmt, timestamp, tz);

        // Apply precision (truncate)
        if (precision >= 0 && formatted.length > precision) {
          formatted = formatted.slice(0, precision);
        }

        // Apply width
        if (width !== 0) {
          const absWidth = Math.abs(width);
          if (formatted.length < absWidth) {
            if (width < 0) {
              // Left-justify
              formatted = formatted.padEnd(absWidth, " ");
            } else {
              // Right-justify
              formatted = formatted.padStart(absWidth, " ");
            }
          }
        }

        pushStr(bytes, formatted);
        i = specStart + fullMatchBytes.length;
        continue;
      }

      // Parse flags: +-0 #'
      while (
        i < format.length &&
        (format[i] === 0x2b || // +
          format[i] === 0x2d || // -
          format[i] === 0x30 || // 0
          format[i] === 0x20 || // space
          format[i] === 0x23 || // #
          format[i] === 0x27) // '
      ) {
        i++;
      }

      // Parse width (can be * to read from args)
      let widthFromArg = false;
      if (format[i] === 0x2a /* * */) {
        widthFromArg = true;
        i++;
      } else {
        while (i < format.length && isDigit(format[i])) {
          i++;
        }
      }

      // Parse precision
      let precisionFromArg = false;
      if (format[i] === 0x2e /* . */) {
        i++;
        if (format[i] === 0x2a /* * */) {
          precisionFromArg = true;
          i++;
        } else {
          while (i < format.length && isDigit(format[i])) {
            i++;
          }
        }
      }

      // Parse length modifier: h, l, L
      if (
        i < format.length &&
        (format[i] === 0x68 || format[i] === 0x6c || format[i] === 0x4c)
      ) {
        i++;
      }

      // Get specifier
      const specifierByte = i < format.length ? format[i] : 0;
      const specifier = specifierByte ? charFromByte(specifierByte) : "";
      i++;

      // Build the full spec string from the bytes
      const specBytes = format.subarray(specStart, i);
      const fullSpec = new TextDecoder().decode(specBytes);

      // Handle width/precision from args
      let adjustedSpec = fullSpec;
      if (widthFromArg) {
        const w = parseInt(args[argPos + argsConsumed] || "0", 10);
        argsConsumed++;
        adjustedSpec = adjustedSpec.replace("*", String(w));
      }
      if (precisionFromArg) {
        const p = parseInt(args[argPos + argsConsumed] || "0", 10);
        argsConsumed++;
        adjustedSpec = adjustedSpec.replace(".*", `.${p}`);
      }

      // Get the argument
      const arg = args[argPos + argsConsumed] || "";
      argsConsumed++;

      // Format based on specifier
      const { value, rawBytes, parseError, parseErrMsg, stopped } = formatValue(
        adjustedSpec,
        specifier,
        arg,
      );
      if (rawBytes) {
        pushBytes(bytes, rawBytes);
      } else {
        pushStr(bytes, value);
      }
      if (parseError) {
        error = true;
        if (parseErrMsg) errMsg = parseErrMsg;
      }
      // If %b with \c was encountered, stop all output immediately
      if (stopped) {
        return {
          result: new Uint8Array(bytes),
          argsConsumed,
          error,
          errMsg,
          stopped: true,
        };
      }
    } else {
      // Literal byte from format string - copy directly
      bytes.push(format[i]);
      i++;
    }
  }

  return {
    result: new Uint8Array(bytes),
    argsConsumed,
    error,
    errMsg,
    stopped: false,
  };
}

/**
 * Format a single value with the given specifier.
 * Returns either `value` (string, to be UTF-8 encoded) or `rawBytes` (Uint8Array, used as-is).
 */
function formatValue(
  spec: string,
  specifier: string,
  arg: string,
): {
  value: string;
  rawBytes?: Uint8Array;
  parseError: boolean;
  parseErrMsg: string;
  stopped?: boolean;
} {
  let parseError = false;
  let parseErrMsg = "";

  switch (specifier) {
    case "d":
    case "i": {
      const num = parseIntArg(arg);
      parseError = lastParseError;
      if (parseError) parseErrMsg = `printf: ${arg}: invalid number\n`;
      return { value: formatInteger(spec, num), parseError, parseErrMsg };
    }
    case "o": {
      const num = parseIntArg(arg);
      parseError = lastParseError;
      if (parseError) parseErrMsg = `printf: ${arg}: invalid number\n`;
      return { value: formatOctal(spec, num), parseError, parseErrMsg };
    }
    case "u": {
      const num = parseIntArg(arg);
      parseError = lastParseError;
      if (parseError) parseErrMsg = `printf: ${arg}: invalid number\n`;
      // For unsigned with negative, convert to unsigned representation
      const unsignedNum = num < 0 ? num >>> 0 : num;
      return {
        value: formatInteger(spec.replace("u", "d"), unsignedNum),
        parseError,
        parseErrMsg,
      };
    }
    case "x":
    case "X": {
      const num = parseIntArg(arg);
      parseError = lastParseError;
      if (parseError) parseErrMsg = `printf: ${arg}: invalid number\n`;
      return { value: formatHex(spec, num), parseError, parseErrMsg };
    }
    case "e":
    case "E":
    case "f":
    case "F":
    case "g":
    case "G": {
      const num = parseFloat(arg) || 0;
      return {
        value: formatFloat(spec, specifier, num),
        parseError: false,
        parseErrMsg: "",
      };
    }
    case "c": {
      // Character - take first BYTE of UTF-8 encoding (not first Unicode character)
      // This matches bash behavior where %c outputs a single byte, not a full character
      if (arg === "") {
        return { value: "", parseError: false, parseErrMsg: "" };
      }
      // Encode the string to UTF-8 and take just the first byte as a raw byte
      const encoded = te.encode(arg);
      return {
        value: "",
        rawBytes: new Uint8Array([encoded[0]]),
        parseError: false,
        parseErrMsg: "",
      };
    }
    case "s":
      return {
        value: formatString(spec, arg),
        parseError: false,
        parseErrMsg: "",
      };
    case "q":
      // Shell quoting with width support
      return {
        value: formatQuoted(spec, arg),
        parseError: false,
        parseErrMsg: "",
      };
    case "b": {
      // Interpret escape sequences in arg, producing raw bytes
      const bResult = processBEscapes(arg);
      return {
        value: "",
        rawBytes: bResult.value,
        parseError: false,
        parseErrMsg: "",
        stopped: bResult.stopped,
      };
    }
    default:
      try {
        return {
          value: sprintf(spec, arg),
          parseError: false,
          parseErrMsg: "",
        };
      } catch {
        return {
          value: "",
          parseError: true,
          parseErrMsg: `printf: [sprintf] unexpected placeholder\n`,
        };
      }
  }
}

/**
 * Error flag for invalid integer parsing - set by parseIntArg
 */
let lastParseError = false;

/**
 * Parse an integer argument, handling bash-style character notation ('a' = 97)
 */
function parseIntArg(arg: string): number {
  lastParseError = false;

  // Only trim leading whitespace - trailing whitespace triggers error but we still parse
  const trimmed = arg.trimStart();
  const hasTrailingWhitespace = trimmed !== trimmed.trimEnd();

  // Continue parsing with trimmed value - but set error flag later if there's trailing whitespace
  arg = trimmed.trimEnd();

  // Handle character notation: 'x' or "x" gives ASCII value
  // Also handle \'x and \"x (escaped quotes, which shell may pass through)
  if (arg.startsWith("'") && arg.length >= 2) {
    return arg.charCodeAt(1);
  }
  if (arg.startsWith('"') && arg.length >= 2) {
    return arg.charCodeAt(1);
  }
  if (arg.startsWith("\\'") && arg.length >= 3) {
    return arg.charCodeAt(2);
  }
  if (arg.startsWith('\\"') && arg.length >= 3) {
    return arg.charCodeAt(2);
  }

  // Handle + prefix (e.g., +42)
  if (arg.startsWith("+")) {
    arg = arg.slice(1);
  }

  // Handle hex
  if (arg.startsWith("0x") || arg.startsWith("0X")) {
    const num = parseInt(arg, 16);
    if (Number.isNaN(num)) {
      lastParseError = true;
      return 0;
    }
    if (hasTrailingWhitespace) lastParseError = true;
    return num;
  }

  // Handle octal
  if (arg.startsWith("0") && arg.length > 1 && /^-?0[0-7]+$/.test(arg)) {
    if (hasTrailingWhitespace) lastParseError = true;
    return parseInt(arg, 8) || 0;
  }

  // Reject arbitrary base notation like 64#a (valid in arithmetic but not printf)
  // Bash parses the number before # and returns that with error status
  if (/^\d+#/.test(arg)) {
    lastParseError = true;
    const match = arg.match(/^(\d+)#/);
    return match ? parseInt(match[1], 10) : 0;
  }

  // Check for invalid characters
  if (arg !== "" && !/^-?\d+$/.test(arg)) {
    lastParseError = true;
    // Try to parse what we can (bash behavior: 3abc -> 3, but sets error)
    const num = parseInt(arg, 10);
    return Number.isNaN(num) ? 0 : num;
  }

  // Set error flag if there was trailing whitespace
  if (hasTrailingWhitespace) lastParseError = true;

  return parseInt(arg, 10) || 0;
}

/**
 * Format an integer with precision support (bash-style: precision means min digits)
 */
function formatInteger(spec: string, num: number): string {
  // Parse the spec: %[flags][width][.precision]d
  // Note: %6.d means precision 0 (dot with no digits)
  const match = spec.match(/^%([- +#0']*)(\d*)(\.(\d*))?[diu]$/);
  if (!match) {
    return sprintf(spec.replace(/\.\d*/, ""), num);
  }

  const flags = match[1] || "";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  // If there's a dot (match[3]), precision is match[4] or 0 if empty
  const precision =
    match[3] !== undefined ? (match[4] ? parseInt(match[4], 10) : 0) : -1;

  const negative = num < 0;
  const absNum = Math.abs(num);
  let numStr = String(absNum);

  // Apply precision (minimum digits with zero-padding)
  if (precision >= 0) {
    numStr = numStr.padStart(precision, "0");
  }

  // Add sign
  let sign = "";
  if (negative) {
    sign = "-";
  } else if (flags.includes("+")) {
    sign = "+";
  } else if (flags.includes(" ")) {
    sign = " ";
  }

  let result = sign + numStr;

  // Apply width
  if (width > result.length) {
    if (flags.includes("-")) {
      result = result.padEnd(width, " ");
    } else if (flags.includes("0") && precision < 0) {
      // Zero-pad only if no precision specified
      result = sign + numStr.padStart(width - sign.length, "0");
    } else {
      result = result.padStart(width, " ");
    }
  }

  return result;
}

/**
 * Format octal with precision support
 */
function formatOctal(spec: string, num: number): string {
  const match = spec.match(/^%([- +#0']*)(\d*)(\.(\d*))?o$/);
  if (!match) {
    return sprintf(spec, num);
  }

  const flags = match[1] || "";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  const precision =
    match[3] !== undefined ? (match[4] ? parseInt(match[4], 10) : 0) : -1;

  let numStr = Math.abs(num).toString(8);

  if (precision >= 0) {
    numStr = numStr.padStart(precision, "0");
  }

  if (flags.includes("#") && !numStr.startsWith("0")) {
    numStr = `0${numStr}`;
  }

  let result = numStr;
  if (width > result.length) {
    if (flags.includes("-")) {
      result = result.padEnd(width, " ");
    } else if (flags.includes("0") && precision < 0) {
      result = result.padStart(width, "0");
    } else {
      result = result.padStart(width, " ");
    }
  }

  return result;
}

/**
 * Format hex with precision support
 */
function formatHex(spec: string, num: number): string {
  const isUpper = spec.includes("X");
  const match = spec.match(/^%([- +#0']*)(\d*)(\.(\d*))?[xX]$/);
  if (!match) {
    return sprintf(spec, num);
  }

  const flags = match[1] || "";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  const precision =
    match[3] !== undefined ? (match[4] ? parseInt(match[4], 10) : 0) : -1;

  let numStr = Math.abs(num).toString(16);
  if (isUpper) numStr = numStr.toUpperCase();

  if (precision >= 0) {
    numStr = numStr.padStart(precision, "0");
  }

  let prefix = "";
  if (flags.includes("#") && num !== 0) {
    prefix = isUpper ? "0X" : "0x";
  }

  let result = prefix + numStr;
  if (width > result.length) {
    if (flags.includes("-")) {
      result = result.padEnd(width, " ");
    } else if (flags.includes("0") && precision < 0) {
      result = prefix + numStr.padStart(width - prefix.length, "0");
    } else {
      result = result.padStart(width, " ");
    }
  }

  return result;
}

/**
 * Shell-quote a string (for %q)
 * Bash uses backslash escaping for printable chars, $'...' only for control chars
 */
function shellQuote(str: string): string {
  if (str === "") {
    return "''";
  }
  // If string contains only safe characters, return as-is
  if (/^[a-zA-Z0-9_./-]+$/.test(str)) {
    return str;
  }

  // Check if we need $'...' syntax (for control chars, newlines, high bytes, etc.)
  // High bytes (0x80-0xff) need escaping as they are not printable ASCII
  const needsDollarQuote = /[\x00-\x1f\x7f-\xff]/.test(str);

  if (needsDollarQuote) {
    // Use $'...' format with escape sequences for control characters
    let result = "$'";
    for (const char of str) {
      const code = char.charCodeAt(0);
      if (char === "'") {
        result += "\\'";
      } else if (char === "\\") {
        result += "\\\\";
      } else if (char === "\n") {
        result += "\\n";
      } else if (char === "\t") {
        result += "\\t";
      } else if (char === "\r") {
        result += "\\r";
      } else if (char === "\x07") {
        result += "\\a";
      } else if (char === "\b") {
        result += "\\b";
      } else if (char === "\f") {
        result += "\\f";
      } else if (char === "\v") {
        result += "\\v";
      } else if (char === "\x1b") {
        result += "\\E";
      } else if (code < 32 || (code >= 127 && code <= 255)) {
        // Use octal escapes like bash does for control chars and high bytes (0x80-0xFF)
        // Valid Unicode chars (code > 255) are left unescaped
        result += `\\${code.toString(8).padStart(3, "0")}`;
      } else if (char === '"') {
        result += '\\"';
      } else {
        result += char;
      }
    }
    result += "'";
    return result;
  }

  // Use backslash escaping for printable special characters
  let result = "";
  for (const char of str) {
    // Characters that need backslash escaping
    if (" \t|&;<>()$`\\\"'*?[#~=%!{}".includes(char)) {
      result += `\\${char}`;
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Format a string with %s, respecting width and precision
 * Note: %06s should NOT zero-pad (0 flag is ignored for strings)
 */
function formatString(spec: string, str: string): string {
  const match = spec.match(/^%(-?)(\d*)(\.(\d*))?s$/);
  if (!match) {
    return sprintf(spec.replace(/0+(?=\d)/, ""), str);
  }

  const leftJustify = match[1] === "-";
  const widthVal = match[2] ? parseInt(match[2], 10) : 0;
  // Precision for strings means max length (truncate)
  // %.s or %0.s means precision 0 (empty string)
  const precision =
    match[3] !== undefined ? (match[4] ? parseInt(match[4], 10) : 0) : -1;

  // Use shared width/alignment utility
  const width = leftJustify ? -widthVal : widthVal;
  return applyWidth(str, width, precision);
}

/**
 * Format a quoted string with %q, respecting width
 */
function formatQuoted(spec: string, str: string): string {
  const quoted = shellQuote(str);

  const match = spec.match(/^%(-?)(\d*)q$/);
  if (!match) {
    return quoted;
  }

  const leftJustify = match[1] === "-";
  const width = match[2] ? parseInt(match[2], 10) : 0;

  let result = quoted;
  if (width > result.length) {
    if (leftJustify) {
      result = result.padEnd(width, " ");
    } else {
      result = result.padStart(width, " ");
    }
  }

  return result;
}

/**
 * Format floating point with default precision and # flag support
 */
function formatFloat(spec: string, specifier: string, num: number): string {
  // Parse spec to extract flags, width, precision
  const match = spec.match(/^%([- +#0']*)(\d*)(\.(\d*))?[eEfFgG]$/);
  if (!match) {
    return sprintf(spec, num);
  }

  const flags = match[1] || "";
  const width = match[2] ? parseInt(match[2], 10) : 0;
  // Default precision is 6 for f/e, but %.f means precision 0
  const precision =
    match[3] !== undefined ? (match[4] ? parseInt(match[4], 10) : 0) : 6;

  let result: string;
  const lowerSpec = specifier.toLowerCase();

  if (lowerSpec === "e") {
    result = num.toExponential(precision);
    // Ensure exponent has at least 2 digits (e+0 -> e+00)
    result = result.replace(/e([+-])(\d)$/, "e$10$2");
    if (specifier === "E") result = result.toUpperCase();
  } else if (lowerSpec === "f") {
    result = num.toFixed(precision);
    // # flag for %f: always show decimal point even if precision is 0
    if (flags.includes("#") && precision === 0 && !result.includes(".")) {
      result += ".";
    }
  } else if (lowerSpec === "g") {
    // %g: use shortest representation between %e and %f
    result = num.toPrecision(precision || 1);
    // # flag: keep trailing zeros (do not omit zeros in fraction)
    // Without #: remove trailing zeros and unnecessary decimal point
    if (!flags.includes("#")) {
      result = result.replace(/\.?0+$/, "");
      result = result.replace(/\.?0+e/, "e");
    }
    // Ensure exponent has at least 2 digits if present
    result = result.replace(/e([+-])(\d)$/, "e$10$2");
    if (specifier === "G") result = result.toUpperCase();
  } else {
    result = num.toString();
  }

  // Handle sign
  if (num >= 0) {
    if (flags.includes("+")) {
      result = `+${result}`;
    } else if (flags.includes(" ")) {
      result = ` ${result}`;
    }
  }

  // Handle width
  if (width > result.length) {
    if (flags.includes("-")) {
      result = result.padEnd(width, " ");
    } else if (flags.includes("0")) {
      const signPrefix = result.match(/^[+ -]/)?.[0] || "";
      const numPart = signPrefix ? result.slice(1) : result;
      result = signPrefix + numPart.padStart(width - signPrefix.length, "0");
    } else {
      result = result.padStart(width, " ");
    }
  }

  return result;
}

/**
 * Process escape sequences in %b argument, producing Uint8Array directly.
 * Similar to processEscapesBytes but with additional features:
 * - \c stops output (discards rest of string and rest of format)
 * - \uHHHH unicode escapes
 * - Octal can be \NNN or \0NNN
 * Returns {value: Uint8Array, stopped} - stopped is true if \c was encountered
 */
function processBEscapes(str: string): {
  value: Uint8Array;
  stopped: boolean;
} {
  const bytes: number[] = [];
  let i = 0;

  while (i < str.length) {
    if (str[i] === "\\" && i + 1 < str.length) {
      const next = str[i + 1];
      switch (next) {
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
        case "\\":
          bytes.push(0x5c);
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
        case "c":
          // \c stops all output - return immediately with stopped flag
          return { value: new Uint8Array(bytes), stopped: true };
        case "x": {
          // \xHH - hex escape (1-2 hex digits) - push raw bytes
          let j = i;
          let found = false;
          while (j + 1 < str.length && str[j] === "\\" && str[j + 1] === "x") {
            let hex = "";
            let k = j + 2;
            while (k < str.length && k < j + 4 && /[0-9a-fA-F]/.test(str[k])) {
              hex += str[k];
              k++;
            }
            if (hex) {
              bytes.push(parseInt(hex, 16));
              j = k;
              found = true;
            } else {
              break;
            }
          }

          if (found) {
            i = j;
          } else {
            pushStr(bytes, "\\x");
            i += 2;
          }
          break;
        }
        case "u": {
          // \uHHHH - unicode escape (1-4 hex digits) -> UTF-8 encoded
          let hex = "";
          let j = i + 2;
          while (j < str.length && j < i + 6 && /[0-9a-fA-F]/.test(str[j])) {
            hex += str[j];
            j++;
          }
          if (hex) {
            pushBytes(
              bytes,
              te.encode(String.fromCodePoint(parseInt(hex, 16))),
            );
            i = j;
          } else {
            pushStr(bytes, "\\u");
            i += 2;
          }
          break;
        }
        case "0": {
          // \0NNN - octal escape (0-3 digits after the 0) - push raw byte
          let octal = "";
          let j = i + 2;
          while (j < str.length && j < i + 5 && /[0-7]/.test(str[j])) {
            octal += str[j];
            j++;
          }
          if (octal) {
            bytes.push(parseInt(octal, 8) & 0xff);
          } else {
            bytes.push(0x00); // Just \0 is NUL
          }
          i = j;
          break;
        }
        case "1":
        case "2":
        case "3":
        case "4":
        case "5":
        case "6":
        case "7": {
          // \NNN - octal escape (1-3 digits, no leading 0) - push raw byte
          let octal = "";
          let j = i + 1;
          while (j < str.length && j < i + 4 && /[0-7]/.test(str[j])) {
            octal += str[j];
            j++;
          }
          bytes.push(parseInt(octal, 8) & 0xff);
          i = j;
          break;
        }
        default:
          // Unknown escape, keep as-is
          pushStr(bytes, str[i]);
          i++;
      }
    } else {
      // Regular character - UTF-8 encode
      const code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
        i++;
      } else {
        const char =
          code >= 0xd800 && code <= 0xdbff && i + 1 < str.length
            ? str.slice(i, i + 2)
            : str[i];
        pushBytes(bytes, te.encode(char));
        i += char.length;
      }
    }
  }

  return { value: new Uint8Array(bytes), stopped: false };
}

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "printf",
  flags: [{ flag: "-v", type: "value", valueHint: "string" }],
  stdinType: "none",
  needsArgs: true,
};
