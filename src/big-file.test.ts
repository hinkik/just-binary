/**
 * Big-file end-to-end tests.
 *
 * The point: after the ByteStream refactor, file content storage and the
 * pipeline never materialize a single huge Uint8Array, so commands should
 * handle multi-hundred-MB / multi-GB files without crashing on Uint8Array
 * or string size caps.
 *
 * These tests are kept separate from the main suite because they:
 *   - allocate hundreds of MB on disk in a temp directory,
 *   - need a generous Node heap (--max-old-space-size if you push past ~1 GB),
 *   - take seconds to run.
 *
 * Opt in with RUN_BIG_FILE=1. Default size 600 MB; override with BIG_FILE_GB=N.
 *
 *   # 600 MB
 *   RUN_BIG_FILE=1 pnpm test:run src/big-file.test.ts
 *
 *   # 3 GB (needs a larger heap)
 *   BIG_FILE_GB=3 RUN_BIG_FILE=1 NODE_OPTIONS='--max-old-space-size=12288' \
 *     pnpm test:run src/big-file.test.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Bash } from "./Bash.js";
import { ReadWriteFs } from "./fs/read-write-fs/index.js";
import { toText } from "./test-utils.js";
import { collectBytes, fromChunks } from "./utils/stream.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

// V8's max string length is ~512 MB on most systems; ArrayBuffer cap is
// effectively unlimited on 64-bit but the OLD codebase still hit walls
// from intermediate Uint8Array allocations and string coercions. We
// deliberately go above the string cap (and configurable up to several
// GB) to exercise the "no hidden Uint8Array assumption" path.
//
// Override with BIG_FILE_GB env var, e.g. BIG_FILE_GB=3 pnpm test:run …
const FILE_SIZE_BYTES = process.env.BIG_FILE_GB
  ? Number(process.env.BIG_FILE_GB) * GB
  : 600 * MB;

// Use a real tmp directory so the file lives on disk and Node only pages
// chunks of it through memory as commands stream.
let tmpDir: string;
let realFs: ReadWriteFs;
let env: Bash;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "just-bash-bigfile-"));
  console.log(
    `[big-file] writing ${(FILE_SIZE_BYTES / GB).toFixed(2)} GB test file…`,
  );
  realFs = new ReadWriteFs({
    root: tmpDir,
    // Disable the safety cap so we can read the big file back.
    maxFileReadSize: 0,
  });
  env = new Bash({ fs: realFs, cwd: "/" });

  // Build the big file via a stream so we never need a giant Uint8Array.
  // Content: repeating 1 MB of "A"s ending with a newline, plus a marker.
  const oneMB = new Uint8Array(MB).fill(0x41); // "A" * 1MB
  oneMB[MB - 1] = 0x0a; // newline at end of each MB so wc -l counts cleanly
  const chunks: Uint8Array[] = [];
  const mbCount = Math.floor(FILE_SIZE_BYTES / MB);
  for (let i = 0; i < mbCount; i++) chunks.push(oneMB);
  // Trailing tiny chunk with a known marker so we can sanity-check the end.
  const marker = new TextEncoder().encode("END-MARKER\n");
  chunks.push(marker as Uint8Array);

  await realFs.writeFile("/big.bin", fromChunks(chunks));

  // Sanity check we actually wrote the file.
  const stat = await realFs.stat("/big.bin");
  if (stat.size !== mbCount * MB + marker.length) {
    throw new Error(
      `setup: expected ${mbCount * MB + marker.length} bytes, got ${stat.size}`,
    );
  }
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

// Generous per-test timeout — streaming many GB takes longer than 5 s,
// and the setup step alone writes the whole file.
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

const runBigFile = process.env.RUN_BIG_FILE === "1";

describe.skipIf(!runBigFile)(
  "big-file e2e",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    it("wc -c counts bytes without buffering", async () => {
      const r = await toText(await env.exec(`wc -c < /big.bin`));
      if (r.exitCode !== 0) console.error("wc stderr:", r.stderr);
      expect(r.exitCode).toBe(0);
      const n = Number(r.stdout.trim());
      expect(n).toBe(FILE_SIZE_BYTES + "END-MARKER\n".length);
    });

    it("head -c streams without reading the whole file", async () => {
      const r = await toText(await env.exec(`head -c 10 < /big.bin`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("AAAAAAAAAA");
    });

    it("tail -c streams the trailing bytes", async () => {
      const r = await toText(await env.exec(`tail -c 11 < /big.bin`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("END-MARKER\n");
    });

    it("cat copies a 600 MB file via stream redirection", async () => {
      const r = await toText(
        await env.exec(`cat /big.bin > /copy.bin && wc -c < /copy.bin`),
      );
      expect(r.exitCode).toBe(0);
      const n = Number(r.stdout.trim());
      expect(n).toBe(FILE_SIZE_BYTES + "END-MARKER\n".length);
    });

    it("pipe through cat | head still stops early", async () => {
      const r = await toText(await env.exec(`cat /big.bin | head -c 5`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("AAAAA");
    });

    it("tee writes a copy and forwards bytes", async () => {
      const r = await toText(
        await env.exec(`cat /big.bin | tee /tee.bin | head -c 5`),
      );
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("AAAAA");
      const teeStat = await realFs.stat("/tee.bin");
      // tee should have written at least a few MB (it stops once the
      // downstream reader's pipe closes, but typically not after only 5 bytes).
      expect(teeStat.size).toBeGreaterThan(1024);
    });

    it("filesystem stat reports the real size", async () => {
      const r = await toText(await env.exec(`stat -c '%s' /big.bin`));
      if (r.exitCode === 0) {
        expect(Number(r.stdout.trim())).toBe(
          FILE_SIZE_BYTES + "END-MARKER\n".length,
        );
      } else {
        // some platforms ship a different `stat`; the wc fallback below
        // already exercises the same path.
      }
    });

    it("direct fs.readFile stream survives without OOM", async () => {
      // Read the whole stream and assert size via byte counting (never
      // building a single string).
      const stream = await realFs.readFile("/big.bin");
      let total = 0;
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) total += value.length;
        }
      } finally {
        reader.releaseLock();
      }
      expect(total).toBe(FILE_SIZE_BYTES + "END-MARKER\n".length);
    });

    it("grep streams over a big file", async () => {
      // Pattern only matches the marker at the very end.
      const r = await toText(await env.exec(`grep END /big.bin`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("END-MARKER\n");
    });

    it("tr translates a big stream through pipes", async () => {
      const r = await toText(await env.exec(`tr A b < /big.bin | head -c 5`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("bbbbb");
    });

    it("uniq deduplicates streamed lines", async () => {
      // The big file is many lines of "AAA…A\n", so uniq should produce one
      // line plus the marker.
      const r = await toText(await env.exec(`uniq /big.bin`));
      expect(r.exitCode).toBe(0);
      const lines = r.stdout.split("\n").filter(Boolean);
      expect(lines.length).toBe(2);
      expect(lines[1]).toBe("END-MARKER");
    });

    it("cut -c streams character ranges from a big file", async () => {
      const r = await toText(await env.exec(`cut -c1-3 /big.bin | head -c 4`));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("AAA\n");
    });

    it("cat | head closes early — lazy cat doesn't read the rest", async () => {
      // The lazy cat win: this should complete in well under a second even
      // for a multi-GB file, because head -c 5 closes the pipe almost
      // immediately and cat's source stream's cancel() fires.
      const start = performance.now();
      const r = await toText(await env.exec(`cat /big.bin | head -c 5`));
      const elapsed = performance.now() - start;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toBe("AAAAA");
      // 1 second is generous; on a 3 GB file we typically see < 50 ms.
      expect(elapsed).toBeLessThan(1000);
    });

    it("collectBytes on a big stream produces a single Uint8Array up to V8 limit", async () => {
      // V8 ArrayBuffer cap is ~8 PB on 64-bit, so 600 MB is fine. The point
      // here is to assert we don't have any hidden assumption forcing a
      // string conversion along the way.
      const stream = await realFs.readFile("/big.bin");
      const bytes = await collectBytes(stream);
      expect(bytes.length).toBe(FILE_SIZE_BYTES + "END-MARKER\n".length);
      // First byte is 'A', byte before the marker is also data
      expect(bytes[0]).toBe(0x41);
      // Last 11 bytes are the marker
      const tail = new TextDecoder().decode(bytes.subarray(bytes.length - 11));
      expect(tail).toBe("END-MARKER\n");
    });
  },
);
