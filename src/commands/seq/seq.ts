import type { Command, ExecResult } from "../../types.js";
import { decodeArgs } from "../../utils/bytes.js";

/**
 * seq - print a sequence of numbers
 *
 * Usage:
 *   seq LAST           - print numbers from 1 to LAST
 *   seq FIRST LAST     - print numbers from FIRST to LAST
 *   seq FIRST INCR LAST - print numbers from FIRST to LAST by INCR
 *
 * Options:
 *   -s STRING  use STRING to separate numbers (default: newline)
 *   -w         equalize width by padding with leading zeros
 *
 * Implementation: pull-based stream. We emit ~16 KiB of output per pull
 * so memory stays O(1) regardless of the sequence length, and a downstream
 * consumer that closes early (e.g. `seq 1 1000000000 | head -c 5`) will
 * cancel us after a single chunk.
 */
export const seqCommand: Command = {
  name: "seq",

  async execute(args: Uint8Array[]): Promise<ExecResult> {
    const a = decodeArgs(args);
    let separator = "\n";
    let equalizeWidth = false;
    const nums: string[] = [];

    // Parse arguments
    let i = 0;
    while (i < a.length) {
      const arg = a[i];

      if (arg === "-s" && i + 1 < a.length) {
        separator = a[i + 1];
        i += 2;
        continue;
      }

      if (arg === "-w") {
        equalizeWidth = true;
        i++;
        continue;
      }

      if (arg === "--") {
        i++;
        break;
      }

      if (arg.startsWith("-") && arg !== "-") {
        if (arg.startsWith("-s") && arg.length > 2) {
          separator = arg.slice(2);
          i++;
          continue;
        }
        if (arg === "-ws" || arg === "-sw") {
          equalizeWidth = true;
          if (i + 1 < a.length) {
            separator = a[i + 1];
            i += 2;
            continue;
          }
        }
        // Unknown option - treat as number (might be negative)
      }

      nums.push(arg);
      i++;
    }

    while (i < a.length) {
      nums.push(a[i]);
      i++;
    }

    if (nums.length === 0) {
      return {
        stdout: emptyStream(),
        stderr: fromString("seq: missing operand\n"),
        exitCode: 1,
      };
    }

    let first = 1;
    let increment = 1;
    let last: number;

    if (nums.length === 1) {
      last = parseFloat(nums[0]);
    } else if (nums.length === 2) {
      first = parseFloat(nums[0]);
      last = parseFloat(nums[1]);
    } else {
      first = parseFloat(nums[0]);
      increment = parseFloat(nums[1]);
      last = parseFloat(nums[2]);
    }

    if (Number.isNaN(first) || Number.isNaN(increment) || Number.isNaN(last)) {
      const invalid = nums.find((n) => Number.isNaN(parseFloat(n)));
      return {
        stdout: emptyStream(),
        stderr: fromString(
          `seq: invalid floating point argument: '${invalid}'\n`,
        ),
        exitCode: 1,
      };
    }

    if (increment === 0) {
      return {
        stdout: emptyStream(),
        stderr: fromString("seq: invalid Zero increment value: '0'\n"),
        exitCode: 1,
      };
    }

    const precision = Math.max(
      getPrecision(first),
      getPrecision(increment),
      getPrecision(last),
    );

    // Pre-compute padding width for -w. Real seq computes width from the
    // formatted first and last values (whichever is wider, ignoring sign).
    let padWidth = 0;
    if (equalizeWidth) {
      const fmtFirst = formatValue(first, precision).replace(/^-/, "");
      const fmtLast = formatValue(last, precision).replace(/^-/, "");
      padWidth = Math.max(fmtFirst.length, fmtLast.length);
    }

    const formatValueOut = (n: number): string => {
      const raw = formatValue(n, precision);
      if (!equalizeWidth) return raw;
      const isNeg = raw.startsWith("-");
      const body = isNeg ? raw.slice(1) : raw;
      const padded = body.padStart(padWidth, "0");
      return isNeg ? `-${padded}` : padded;
    };

    // Decide whether the sequence is ascending or descending. If
    // (last - first) and increment have opposite signs, output is empty.
    const ascending = increment > 0;
    if (ascending && first > last) {
      return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 0 };
    }
    if (!ascending && first < last) {
      return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 0 };
    }

    // Pull-based emitter. Each pull produces up to ~16 KiB of output.
    const CHUNK_BUDGET = 16 * 1024;
    let current = first;
    let isFirstValue = true;
    let done = false;
    const encoder = new TextEncoder();

    const stream: import("../../utils/stream.js").ByteStream =
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (done) {
            controller.close();
            return;
          }
          let buffer = "";
          while (buffer.length < CHUNK_BUDGET) {
            const finished = ascending
              ? current > last + 1e-10
              : current < last - 1e-10;
            if (finished) {
              done = true;
              if (!isFirstValue) buffer += "\n"; // final newline
              break;
            }
            const formatted = formatValueOut(current);
            if (isFirstValue) {
              buffer += formatted;
              isFirstValue = false;
            } else {
              buffer += separator + formatted;
            }
            current += increment;
          }
          if (buffer.length > 0) {
            controller.enqueue(encoder.encode(buffer) as Uint8Array);
          } else if (done) {
            controller.close();
          }
        },
      });

    return { stdout: stream, stderr: emptyStream(), exitCode: 0 };
  },
};

function getPrecision(n: number): number {
  const str = String(n);
  const dotIndex = str.indexOf(".");
  return dotIndex === -1 ? 0 : str.length - dotIndex - 1;
}

function formatValue(n: number, precision: number): string {
  return precision > 0 ? n.toFixed(precision) : String(Math.round(n));
}

import { emptyStream, fromString } from "../../utils/stream.js";
import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "seq",
  flags: [
    { flag: "-s", type: "value", valueHint: "string" },
    { flag: "-w", type: "boolean" },
  ],
  needsArgs: true,
};
