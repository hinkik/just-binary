import type { Command, CommandContext, ExecResult } from "../../types.js";
import { parseArgs } from "../../utils/args.js";
import { decodeArgs } from "../../utils/bytes.js";
import {
  type ByteStream,
  fromChunks,
  fromString,
  streamChunks,
} from "../../utils/stream.js";
import { hasHelpFlag, showHelp } from "../help.js";

const teeHelp = {
  name: "tee",
  summary: "read from stdin and write to stdout and files",
  usage: "tee [OPTION]... [FILE]...",
  options: [
    "-a, --append     append to the given FILEs, do not overwrite",
    "    --help       display this help and exit",
  ],
};

const argDefs = {
  append: { short: "a", long: "append", type: "boolean" as const },
};

export const teeCommand: Command = {
  name: "tee",

  async execute(args: Uint8Array[], ctx: CommandContext): Promise<ExecResult> {
    const a = decodeArgs(args);
    if (hasHelpFlag(a)) {
      return showHelp(teeHelp);
    }

    const parsed = parseArgs("tee", a, argDefs);
    if (!parsed.ok) return parsed.error;

    const { append } = parsed.result.flags;
    const files = parsed.result.positional;

    // Stream stdin → split each chunk to every output file and accumulate
    // for stdout. We can't ship a "live" stdout stream because writeFile
    // returns a Promise we must await before signalling completion; instead
    // we collect chunks into an array (chunked storage, no single Uint8Array
    // limit) and emit via fromChunks.
    const outChunks: Uint8Array[] = [];
    // For non-append the first chunk truncates the file; for append we
    // always appendFile. We can do this incrementally — first write
    // truncates+writes the chunk, subsequent writes append.
    let stderr = "";
    let exitCode = 0;
    const seeded = new Set<string>();
    const tooManyOpenErrored = new Set<string>();
    const resolvedPaths: string[] = [];
    for (const f of files) resolvedPaths.push(ctx.fs.resolvePath(ctx.cwd, f));

    // Truncate non-append targets up-front so empty-input case still
    // produces empty files.
    if (!append) {
      for (let i = 0; i < files.length; i++) {
        try {
          await ctx.fs.writeFile(resolvedPaths[i], "");
          seeded.add(resolvedPaths[i]);
        } catch {
          stderr += `tee: ${files[i]}: No such file or directory\n`;
          exitCode = 1;
          tooManyOpenErrored.add(resolvedPaths[i]);
        }
      }
    }

    for await (const chunk of streamChunks(ctx.stdin)) {
      outChunks.push(chunk);
      for (let i = 0; i < files.length; i++) {
        const real = resolvedPaths[i];
        if (tooManyOpenErrored.has(real)) continue;
        try {
          if (!append && seeded.has(real)) {
            await ctx.fs.appendFile(real, chunk);
          } else if (append) {
            await ctx.fs.appendFile(real, chunk);
          } else {
            await ctx.fs.writeFile(real, chunk);
            seeded.add(real);
          }
        } catch {
          if (!tooManyOpenErrored.has(real)) {
            stderr += `tee: ${files[i]}: No such file or directory\n`;
            exitCode = 1;
            tooManyOpenErrored.add(real);
          }
        }
      }
    }

    return {
      stdout: outChunks.length > 0 ? (fromChunks(outChunks) as ByteStream) : fromString(""),
      stderr: fromString(stderr),
      exitCode,
    };
  },
};

import type { CommandFuzzInfo } from "../fuzz-flags-types.js";

export const flagsForFuzzing: CommandFuzzInfo = {
  name: "tee",
  flags: [{ flag: "-a", type: "boolean" }],
  stdinType: "text",
  needsArgs: true,
};
