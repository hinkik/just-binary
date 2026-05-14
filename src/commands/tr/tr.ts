import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { decodeArgs } from "../../utils/bytes.js";
import { streamChunks } from "../../utils/stream.js";
import { hasHelpFlag, showHelp } from "../help.js";

const trHelp = {
  name: "tr",
  summary: "translate or delete characters",
  usage: "tr [OPTION]... SET1 [SET2]",
  options: [
    "-c, -C, --complement   use the complement of SET1",
    "-d, --delete           delete characters in SET1",
    "-s, --squeeze-repeats  squeeze repeated characters",
    "    --help             display this help and exit",
  ],
  description: `SET syntax:
  a-z         character range
  [:alnum:]   all letters and digits
  [:alpha:]   all letters
  [:digit:]   all digits
  [:lower:]   all lowercase letters
  [:upper:]   all uppercase letters
  [:space:]   all whitespace
  [:blank:]   horizontal whitespace
  [:punct:]   all punctuation
  [:print:]   all printable characters
  [:graph:]   all printable characters except space
  [:cntrl:]   all control characters
  [:xdigit:]  all hexadecimal digits
  \\n, \\t, \\r  escape sequences`,
};

// POSIX character class definitions (Map prevents prototype pollution)
const POSIX_CLASSES = new Map<string, string>([
  [
    "[:alnum:]",
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  ],
  ["[:alpha:]", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"],
  ["[:blank:]", " \t"],
  [
    "[:cntrl:]",
    Array.from({ length: 32 }, (_, i) => String.fromCharCode(i))
      .join("")
      .concat(String.fromCharCode(127)),
  ],
  ["[:digit:]", "0123456789"],
  [
    "[:graph:]",
    Array.from({ length: 94 }, (_, i) => String.fromCharCode(33 + i)).join(""),
  ],
  ["[:lower:]", "abcdefghijklmnopqrstuvwxyz"],
  [
    "[:print:]",
    Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join(""),
  ],
  ["[:punct:]", "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~"],
  ["[:space:]", " \t\n\r\f\v"],
  ["[:upper:]", "ABCDEFGHIJKLMNOPQRSTUVWXYZ"],
  ["[:xdigit:]", "0123456789ABCDEFabcdef"],
]);

function expandRange(set: string): string {
  let result = "";
  let i = 0;

  while (i < set.length) {
    // Check for POSIX character classes like [:alnum:]
    if (set[i] === "[" && set[i + 1] === ":") {
      let found = false;
      for (const [className, chars] of POSIX_CLASSES) {
        if (set.slice(i).startsWith(className)) {
          result += chars;
          i += className.length;
          found = true;
          break;
        }
      }
      if (found) continue;
    }

    // Handle escape sequences
    if (set[i] === "\\" && i + 1 < set.length) {
      const next = set[i + 1];
      if (next === "n") {
        result += "\n";
      } else if (next === "t") {
        result += "\t";
      } else if (next === "r") {
        result += "\r";
      } else {
        result += next;
      }
      i += 2;
      continue;
    }

    // Handle character ranges like a-z
    if (i + 2 < set.length && set[i + 1] === "-") {
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

const argDefs = {
  complement: { short: "c", long: "complement", type: "boolean" as const },
  complementUpper: { short: "C", type: "boolean" as const },
  delete: { short: "d", long: "delete", type: "boolean" as const },
  squeeze: { short: "s", long: "squeeze-repeats", type: "boolean" as const },
};

export const trCommand: Command = {
  name: "tr",
  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(trHelp);
    }

    const parsed = parseArgs("tr", a, argDefs);
    if (!parsed.ok) return parsed.error;

    // -c and -C both enable complement mode
    const complementMode =
      parsed.result.flags.complement || parsed.result.flags.complementUpper;
    const deleteMode = parsed.result.flags.delete;
    const squeezeMode = parsed.result.flags.squeeze;
    const sets = parsed.result.positional;

    if (sets.length < 1) {
      return {
        stdout: emptyStream(),
        stderr: fromString("tr: missing operand\n"),
        exitCode: 1,
      };
    }

    if (!deleteMode && !squeezeMode && sets.length < 2) {
      return {
        stdout: emptyStream(),
        stderr: fromString("tr: missing operand after SET1\n"),
        exitCode: 1,
      };
    }

    const set1Raw = expandRange(sets[0]);
    const set2 = sets.length > 1 ? expandRange(sets[1]) : "";

    const isInSet1 = (char: string): boolean => {
      const inSet = set1Raw.includes(char);
      return complementMode ? !inSet : inSet;
    };

    // Pre-build the translation map once.
    let translationMap: Map<string, string> | null = null;
    let complementTarget = "";
    if (!deleteMode && !(squeezeMode && sets.length === 1)) {
      if (complementMode) {
        complementTarget = set2.length > 0 ? set2[set2.length - 1] : "";
      } else {
        translationMap = new Map<string, string>();
        for (let i = 0; i < set1Raw.length; i++) {
          const targetChar =
            i < set2.length ? set2[i] : set2[set2.length - 1];
          translationMap.set(set1Raw[i], targetChar);
        }
      }
    }

    // Stream-transform stdin chunks. UTF-8 boundary handling via the
    // decoder's stream mode.
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let prevChar = "";

    const transformText = (text: string): string => {
      let out = "";
      if (deleteMode) {
        for (const char of text) {
          if (!isInSet1(char)) out += char;
        }
        return out;
      }
      if (squeezeMode && sets.length === 1) {
        // Squeeze repeated chars in set1
        for (const char of text) {
          if (isInSet1(char) && char === prevChar) continue;
          out += char;
          prevChar = char;
        }
        return out;
      }
      // Translate
      if (complementMode) {
        for (const char of text) {
          out += set1Raw.includes(char) ? char : complementTarget;
        }
      } else {
        const map = translationMap as Map<string, string>;
        for (const char of text) {
          out += map.get(char) ?? char;
        }
      }
      if (squeezeMode) {
        // Squeeze set2 chars in the translated output
        let squeezed = "";
        for (const char of out) {
          if (set2.includes(char) && char === prevChar) continue;
          squeezed += char;
          prevChar = char;
        }
        return squeezed;
      }
      return out;
    };

    // Pull-based so a downstream `head -c N` can cancel us early and stop
    // reading from cat / the file mid-stream.
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let upstreamDone = false;
    const outStream: import("../../utils/stream.js").ByteStream =
      new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (reader === null && !upstreamDone) reader = ctx.stdin.getReader();
          while (true) {
            if (upstreamDone) {
              const trailing = decoder.decode();
              if (trailing.length > 0) {
                const transformed = transformText(trailing);
                if (transformed.length > 0) {
                  controller.enqueue(encoder.encode(transformed) as Uint8Array);
                  return;
                }
              }
              controller.close();
              return;
            }
            const r = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
            if (r.done) {
              upstreamDone = true;
              (reader as ReadableStreamDefaultReader<Uint8Array>).releaseLock();
              reader = null;
              continue;
            }
            const chunk = r.value;
            if (!chunk || chunk.length === 0) continue;
            const text = decoder.decode(chunk, { stream: true });
            const transformed = transformText(text);
            if (transformed.length > 0) {
              controller.enqueue(encoder.encode(transformed) as Uint8Array);
              return;
            }
          }
        },
        async cancel() {
          if (reader) {
            try {
              await reader.cancel();
            } catch {
              // ignore
            }
            reader = null;
          }
        },
      });

    return { stdout: outStream, stderr: emptyStream(), exitCode: 0 };
  },
};

import { emptyStream, fromString } from "../../utils/stream.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "tr",
  flags: [
    { flag: "-c", type: "boolean" },
    { flag: "-C", type: "boolean" },
    { flag: "-d", type: "boolean" },
    { flag: "-s", type: "boolean" },
  ],
  stdinType: "text",
  needsArgs: true,
};
