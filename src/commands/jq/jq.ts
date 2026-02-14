/**
 * jq - Command-line JSON processor
 *
 * Full jq implementation with proper parser and evaluator.
 */

import { ExecutionLimitError } from "../../interpreter/errors.js";
import type { Command, CommandContext, ExecResult } from "../../types.js";
import {
  createStringEnvAdapter,
  decode,
  decodeArgs,
  EMPTY,
  encode,
} from "../../utils/bytes.js";
import { readFiles } from "../../utils/file-reader.js";
import { hasHelpFlag, showHelp, unknownOption } from "../help.js";
import {
  type EvaluateOptions,
  evaluate,
  parse,
  type QueryValue,
} from "../query-engine/index.js";

/**
 * Parse a JSON stream (concatenated JSON values).
 * Real jq can handle `{...}{...}` or `{...}\n{...}` or pretty-printed concatenated JSONs.
 */
function parseJsonStream(input: string): unknown[] {
  const results: unknown[] = [];
  let pos = 0;
  const len = input.length;

  while (pos < len) {
    // Skip whitespace
    while (pos < len && /\s/.test(input[pos])) pos++;
    if (pos >= len) break;

    const startPos = pos;
    const char = input[pos];

    if (char === "{" || char === "[") {
      // Parse object or array by finding matching close bracket
      const openBracket = char;
      const closeBracket = char === "{" ? "}" : "]";
      let depth = 1;
      let inString = false;
      let isEscaped = false;
      pos++;

      while (pos < len && depth > 0) {
        const c = input[pos];
        if (isEscaped) {
          isEscaped = false;
        } else if (c === "\\") {
          isEscaped = true;
        } else if (c === '"') {
          inString = !inString;
        } else if (!inString) {
          if (c === openBracket) depth++;
          else if (c === closeBracket) depth--;
        }
        pos++;
      }

      if (depth !== 0) {
        throw new Error(
          `Unexpected end of JSON input at position ${pos} (unclosed ${openBracket})`,
        );
      }

      results.push(JSON.parse(input.slice(startPos, pos)));
    } else if (char === '"') {
      // Parse string
      let isEscaped = false;
      pos++;
      while (pos < len) {
        const c = input[pos];
        if (isEscaped) {
          isEscaped = false;
        } else if (c === "\\") {
          isEscaped = true;
        } else if (c === '"') {
          pos++;
          break;
        }
        pos++;
      }
      results.push(JSON.parse(input.slice(startPos, pos)));
    } else if (char === "-" || (char >= "0" && char <= "9")) {
      // Parse number
      while (pos < len && /[\d.eE+-]/.test(input[pos])) pos++;
      results.push(JSON.parse(input.slice(startPos, pos)));
    } else if (input.slice(pos, pos + 4) === "true") {
      results.push(true);
      pos += 4;
    } else if (input.slice(pos, pos + 5) === "false") {
      results.push(false);
      pos += 5;
    } else if (input.slice(pos, pos + 4) === "null") {
      results.push(null);
      pos += 4;
    } else {
      // Try to provide context about what we found
      const context = input.slice(pos, pos + 10);
      throw new Error(
        `Invalid JSON at position ${startPos}: unexpected '${context.split(/\s/)[0]}'`,
      );
    }
  }

  return results;
}

const jqHelp = {
  name: "jq",
  summary: "command-line JSON processor",
  usage: "jq [OPTIONS] FILTER [FILE]",
  options: [
    "-r, --raw-output  output strings without quotes",
    "-c, --compact     compact output (no pretty printing)",
    "-e, --exit-status set exit status based on output",
    "-s, --slurp       read entire input into array",
    "-n, --null-input  don't read any input",
    "-j, --join-output don't print newlines after each output",
    "-a, --ascii       force ASCII output",
    "-S, --sort-keys   sort object keys",
    "-C, --color       colorize output (ignored)",
    "-M, --monochrome  monochrome output (ignored)",
    "    --tab         use tabs for indentation",
    "    --help        display this help and exit",
  ],
};

function formatValue(
  v: QueryValue,
  compact: boolean,
  raw: boolean,
  sortKeys: boolean,
  useTab: boolean,
  indent = 0,
): string {
  if (v === null) return "null";
  if (v === undefined) return "null";
  if (typeof v === "boolean") return String(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return "null";
    return String(v);
  }
  if (typeof v === "string") return raw ? v : JSON.stringify(v);

  const indentStr = useTab ? "\t" : "  ";

  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (compact) {
      return `[${v.map((x) => formatValue(x, true, false, sortKeys, useTab)).join(",")}]`;
    }
    const items = v.map(
      (x) =>
        indentStr.repeat(indent + 1) +
        formatValue(x, false, false, sortKeys, useTab, indent + 1),
    );
    return `[\n${items.join(",\n")}\n${indentStr.repeat(indent)}]`;
  }

  if (typeof v === "object") {
    let keys = Object.keys(v as object);
    if (sortKeys) keys = keys.sort();
    if (keys.length === 0) return "{}";
    if (compact) {
      // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
      return `{${keys.map((k) => `${JSON.stringify(k)}:${formatValue((v as Record<string, unknown>)[k], true, false, sortKeys, useTab)}`).join(",")}}`;
    }
    const items = keys.map((k) => {
      // @banned-pattern-ignore: iterating via Object.keys() which only returns own properties
      const val = formatValue(
        (v as Record<string, unknown>)[k],
        false,
        false,
        sortKeys,
        useTab,
        indent + 1,
      );
      return `${indentStr.repeat(indent + 1)}${JSON.stringify(k)}: ${val}`;
    });
    return `{\n${items.join(",\n")}\n${indentStr.repeat(indent)}}`;
  }

  return String(v);
}

export const jqCommand: Command = {
  name: "jq",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) return showHelp(jqHelp);

    let raw = false;
    let compact = false;
    let exitStatus = false;
    let slurp = false;
    let nullInput = false;
    let joinOutput = false;
    let sortKeys = false;
    let useTab = false;
    let filter = ".";
    let filterSet = false;
    const files: string[] = [];

    for (let i = 0; i < a.length; i++) {
      const arg = a[i];
      if (arg === "-r" || arg === "--raw-output") raw = true;
      else if (arg === "-c" || arg === "--compact-output") compact = true;
      else if (arg === "-e" || arg === "--exit-status") exitStatus = true;
      else if (arg === "-s" || arg === "--slurp") slurp = true;
      else if (arg === "-n" || arg === "--null-input") nullInput = true;
      else if (arg === "-j" || arg === "--join-output") joinOutput = true;
      else if (arg === "-a" || arg === "--ascii") {
        /* ignored */
      } else if (arg === "-S" || arg === "--sort-keys") sortKeys = true;
      else if (arg === "-C" || arg === "--color") {
        /* ignored */
      } else if (arg === "-M" || arg === "--monochrome") {
        /* ignored */
      } else if (arg === "--tab") useTab = true;
      else if (arg === "-") files.push("-");
      else if (arg.startsWith("--")) return unknownOption("jq", arg);
      else if (arg.startsWith("-")) {
        for (const c of arg.slice(1)) {
          if (c === "r") raw = true;
          else if (c === "c") compact = true;
          else if (c === "e") exitStatus = true;
          else if (c === "s") slurp = true;
          else if (c === "n") nullInput = true;
          else if (c === "j") joinOutput = true;
          else if (c === "a") {
            /* ignored */
          } else if (c === "S") sortKeys = true;
          else if (c === "C") {
            /* ignored */
          } else if (c === "M") {
            /* ignored */
          } else return unknownOption("jq", `-${c}`);
        }
      } else if (!filterSet) {
        filter = arg;
        filterSet = true;
      } else {
        files.push(arg);
      }
    }

    // Build list of inputs: stdin or files
    let inputs: { source: string; content: string }[] = [];
    if (nullInput) {
      // No input
    } else if (files.length === 0 || (files.length === 1 && files[0] === "-")) {
      inputs.push({ source: "stdin", content: decode(ctx.stdin) });
    } else {
      // Read all files in parallel using shared utility
      const result = await readFiles(ctx, files, {
        cmdName: "jq",
        stopOnError: true,
      });
      if (result.exitCode !== 0) {
        return {
          stdout: EMPTY,
          stderr: encode(result.stderr),
          exitCode: 2, // jq uses exit code 2 for file errors
        };
      }
      inputs = result.files.map((f) => ({
        source: f.filename || "stdin",
        content: decode(f.content),
      }));
    }

    try {
      const ast = parse(filter);
      let values: QueryValue[] = [];

      const evalOptions: EvaluateOptions = {
        limits: ctx.limits
          ? { maxIterations: ctx.limits.maxJqIterations }
          : undefined,
        env: createStringEnvAdapter(ctx.env),
        coverage: ctx.coverage,
      };

      if (nullInput) {
        values = evaluate(null, ast, evalOptions);
      } else if (slurp) {
        // Slurp mode: combine all inputs into single array
        // Use JSON stream parser to handle concatenated JSON (not just NDJSON)
        const items: QueryValue[] = [];
        for (const { content } of inputs) {
          const trimmed = content.trim();
          if (trimmed) {
            items.push(...parseJsonStream(trimmed));
          }
        }
        values = evaluate(items, ast, evalOptions);
      } else {
        // Process each input file separately
        // Use JSON stream parser to handle concatenated JSON (e.g., cat file1.json file2.json | jq .)
        for (const { content } of inputs) {
          const trimmed = content.trim();
          if (!trimmed) continue;

          const jsonValues = parseJsonStream(trimmed);
          for (const jsonValue of jsonValues) {
            values.push(...evaluate(jsonValue, ast, evalOptions));
          }
        }
      }

      const formatted = values.map((v) =>
        formatValue(v, compact, raw, sortKeys, useTab),
      );
      const separator = joinOutput ? "" : "\n";
      const output = formatted.join(separator);

      // Check output size against limit
      const maxStringLength = ctx.limits?.maxStringLength;
      if (
        maxStringLength !== undefined &&
        maxStringLength > 0 &&
        output.length > maxStringLength
      ) {
        throw new ExecutionLimitError(
          `jq: output size limit exceeded (${maxStringLength} bytes)`,
          "string_length",
        );
      }

      const exitCode =
        exitStatus &&
        (values.length === 0 ||
          values.every((v) => v === null || v === undefined || v === false))
          ? 1
          : 0;

      return {
        stdout: encode(output ? (joinOutput ? output : `${output}\n`) : ""),
        stderr: EMPTY,
        exitCode,
      };
    } catch (e) {
      if (e instanceof ExecutionLimitError) {
        return {
          stdout: EMPTY,
          stderr: encode(`jq: ${e.message}\n`),
          exitCode: ExecutionLimitError.EXIT_CODE,
        };
      }
      const msg = (e as Error).message;
      if (msg.includes("Unknown function")) {
        return {
          stdout: EMPTY,
          stderr: encode(`jq: error: ${msg}\n`),
          exitCode: 3,
        };
      }
      return {
        stdout: EMPTY,
        stderr: encode(`jq: parse error: ${msg}\n`),
        exitCode: 5,
      };
    }
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "jq",
  flags: [
    { flag: "-r", type: "boolean" },
    { flag: "-c", type: "boolean" },
    { flag: "-e", type: "boolean" },
    { flag: "-s", type: "boolean" },
    { flag: "-n", type: "boolean" },
    { flag: "-j", type: "boolean" },
    { flag: "-S", type: "boolean" },
    { flag: "--tab", type: "boolean" },
  ],
  stdinType: "json",
  needsArgs: true,
};
