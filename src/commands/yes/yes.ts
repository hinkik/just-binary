import type { Command, ExecResult } from "../../types.js";
import { decodeArgs } from "../../utils/bytes.js";
import { type ByteStream, emptyStream } from "../../utils/stream.js";

/**
 * yes - output a string repeatedly until killed
 *
 * Usage: yes [STRING]
 *
 * Streams the repeated line via a pull-based ReadableStream so memory stays
 * O(1) regardless of how long the consumer reads for. A downstream consumer
 * that closes early (e.g. `yes | head -c 100`) cancels us after a single
 * pull.
 */
export const yesCommand: Command = {
  name: "yes",

  async execute(args: Uint8Array[]): Promise<ExecResult> {
    const a = decodeArgs(args);
    const line = `${a.length === 0 ? "y" : a.join(" ")}\n`;
    const encoded = new TextEncoder().encode(line);
    // Emit a 16 KiB chunk per pull, regardless of line length.
    const CHUNK_BUDGET = 16 * 1024;
    const repeatCount = Math.max(1, Math.floor(CHUNK_BUDGET / encoded.length));
    const chunkSize = encoded.length * repeatCount;
    const chunk = new Uint8Array(chunkSize);
    for (let i = 0; i < repeatCount; i++) {
      chunk.set(encoded, i * encoded.length);
    }
    const stdout: ByteStream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk as Uint8Array);
      },
    });
    return { stdout, stderr: emptyStream(), exitCode: 0 };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "yes",
  flags: [],
};
