import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryFs } from "./in-memory-fs/in-memory-fs.js";
import { MountableFs } from "./mountable-fs/mountable-fs.js";
import { OverlayFs } from "./overlay-fs/overlay-fs.js";
import { ReadWriteFs } from "./read-write-fs/read-write-fs.js";

const CONTENTS = new Uint8Array(200 * 1024); // 200 KiB (> CHUNK_SIZE of 64 KiB)
for (let i = 0; i < CONTENTS.length; i++) {
  CONTENTS[i] = i & 0xff;
}

function expectSlice(result: Uint8Array, offset: number, length: number): void {
  const expectedEnd = Math.min(offset + length, CONTENTS.length);
  const expectedLen = Math.max(0, expectedEnd - offset);
  expect(result.length).toBe(expectedLen);
  for (let i = 0; i < expectedLen; i++) {
    expect(result[i]).toBe(CONTENTS[offset + i]);
  }
}

describe("readRange — InMemoryFs", () => {
  it("reads a range crossing chunk boundaries", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/big.bin", CONTENTS);

    // Spans across the 64KiB chunk boundary
    const result = await fs.readRange("/big.bin", 60 * 1024, 10 * 1024);
    expectSlice(result, 60 * 1024, 10 * 1024);
  });

  it("reads from offset 0", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/big.bin", CONTENTS);
    const result = await fs.readRange("/big.bin", 0, 100);
    expectSlice(result, 0, 100);
  });

  it("truncates when range extends past EOF", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/big.bin", CONTENTS);
    const result = await fs.readRange("/big.bin", CONTENTS.length - 10, 1000);
    expect(result.length).toBe(10);
    expectSlice(result, CONTENTS.length - 10, 10);
  });

  it("returns empty when offset is at or past EOF", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/big.bin", CONTENTS);
    expect((await fs.readRange("/big.bin", CONTENTS.length, 10)).length).toBe(
      0,
    );
    expect(
      (await fs.readRange("/big.bin", CONTENTS.length + 50, 10)).length,
    ).toBe(0);
  });

  it("returns empty for zero-length read", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/big.bin", CONTENTS);
    expect((await fs.readRange("/big.bin", 100, 0)).length).toBe(0);
  });

  it("follows symlinks", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/big.bin", CONTENTS);
    await fs.symlink("/big.bin", "/link.bin");
    const result = await fs.readRange("/link.bin", 1000, 100);
    expectSlice(result, 1000, 100);
  });

  it("throws ENOENT for missing files", async () => {
    const fs = new InMemoryFs();
    await expect(fs.readRange("/nope", 0, 10)).rejects.toThrow(/ENOENT/);
  });

  it("throws EISDIR for directories", async () => {
    const fs = new InMemoryFs();
    await fs.mkdir("/d");
    await expect(fs.readRange("/d", 0, 10)).rejects.toThrow(/EISDIR/);
  });

  it("rejects invalid offset/length", async () => {
    const fs = new InMemoryFs();
    await fs.writeFile("/big.bin", CONTENTS);
    await expect(fs.readRange("/big.bin", -1, 10)).rejects.toThrow(/EINVAL/);
    await expect(fs.readRange("/big.bin", 0, -1)).rejects.toThrow(/EINVAL/);
    await expect(fs.readRange("/big.bin", 1.5, 10)).rejects.toThrow(/EINVAL/);
    await expect(fs.readRange("/big.bin", Number.NaN, 10)).rejects.toThrow(
      /EINVAL/,
    );
  });
});

describe("readRange — ReadWriteFs", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "just-bash-range-"));
    fs.writeFileSync(path.join(tmpDir, "big.bin"), CONTENTS);
    fs.mkdirSync(path.join(tmpDir, "subdir"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a range from the real filesystem", async () => {
    const rwfs = new ReadWriteFs({ root: tmpDir });
    const result = await rwfs.readRange("/big.bin", 60 * 1024, 10 * 1024);
    expectSlice(result, 60 * 1024, 10 * 1024);
  });

  it("truncates past EOF and never over-reads", async () => {
    const rwfs = new ReadWriteFs({ root: tmpDir });
    const result = await rwfs.readRange("/big.bin", CONTENTS.length - 5, 1000);
    expect(result.length).toBe(5);
    expectSlice(result, CONTENTS.length - 5, 5);
  });

  it("throws ENOENT / EISDIR", async () => {
    const rwfs = new ReadWriteFs({ root: tmpDir });
    await expect(rwfs.readRange("/nope", 0, 10)).rejects.toThrow(/ENOENT/);
    await expect(rwfs.readRange("/subdir", 0, 10)).rejects.toThrow(/EISDIR/);
  });
});

describe("readRange — OverlayFs", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "just-bash-overlay-"));
    fs.writeFileSync(path.join(tmpDir, "real.bin"), CONTENTS);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads a range from a real-fs-backed file (lazy seek)", async () => {
    const ofs = new OverlayFs({ root: tmpDir, mountPoint: "/" });
    const result = await ofs.readRange("/real.bin", 100 * 1024, 4 * 1024);
    expectSlice(result, 100 * 1024, 4 * 1024);
  });

  it("reads a range from an in-memory overlay file", async () => {
    const ofs = new OverlayFs({ root: tmpDir, mountPoint: "/" });
    await ofs.writeFile("/mem.bin", CONTENTS);
    const result = await ofs.readRange("/mem.bin", 80 * 1024, 1024);
    expectSlice(result, 80 * 1024, 1024);
  });

  it("overlay write shadows real file for range reads", async () => {
    const ofs = new OverlayFs({ root: tmpDir, mountPoint: "/" });
    const overwrite = new Uint8Array(100).fill(0xab);
    await ofs.writeFile("/real.bin", overwrite);
    const result = await ofs.readRange("/real.bin", 0, 10);
    expect(result.length).toBe(10);
    for (const b of result) expect(b).toBe(0xab);
  });
});

describe("readRange — MountableFs", () => {
  it("delegates to the backend at the mount point", async () => {
    const data = new InMemoryFs();
    await data.writeFile("/big.bin", CONTENTS);

    const mfs = new MountableFs();
    mfs.mount("/data", data);

    const result = await mfs.readRange("/data/big.bin", 60 * 1024, 10 * 1024);
    expectSlice(result, 60 * 1024, 10 * 1024);
  });
});
