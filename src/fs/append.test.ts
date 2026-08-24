import { describe, expect, it } from "vitest";
import { collectBytes } from "../utils/stream.js";
import { appendChunksToEntry } from "./append.js";
import { InMemoryFs } from "./in-memory-fs/index.js";
import type { FileEntry } from "./interface.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function fileEntry(): FileEntry {
  return {
    type: "file",
    chunks: [],
    size: 0,
    mode: 0o644,
    mtime: new Date(),
  };
}

describe("appendChunksToEntry", () => {
  it("coalesces small appends into a shared tail buffer", () => {
    const entry = fileEntry();
    for (let i = 0; i < 1000; i++) {
      appendChunksToEntry(entry, [enc.encode("ab")], 2);
    }
    expect(entry.size).toBe(2000);
    // 2000 bytes at 4KiB tail capacity: one chunk, not one per append.
    expect(entry.chunks.length).toBe(1);
    expect(dec.decode(entry.chunks[0])).toBe("ab".repeat(1000));
  });

  it("pushes large chunks directly without copying", () => {
    const entry = fileEntry();
    const big = new Uint8Array(65536).fill(7);
    appendChunksToEntry(entry, [big], big.length);
    expect(entry.chunks[0]).toBe(big);
    expect(entry.size).toBe(65536);
  });

  it("does not mutate previously exposed views when the tail grows", () => {
    const entry = fileEntry();
    appendChunksToEntry(entry, [enc.encode("first")], 5);
    const snapshot = entry.chunks[0];
    const before = dec.decode(snapshot);
    appendChunksToEntry(entry, [enc.encode("-second")], 7);
    expect(dec.decode(snapshot)).toBe(before);
    expect(dec.decode(entry.chunks[0])).toBe("first-second");
  });
});

describe("InMemoryFs append behavior", () => {
  it("appends in place and keeps cp copies independent", async () => {
    const fs = new InMemoryFs({ "/a.txt": "one" });
    await fs.cp("/a.txt", "/b.txt");
    await fs.appendFile("/a.txt", "-two");
    expect(await fs.readFileText("/a.txt")).toBe("one-two");
    expect(await fs.readFileText("/b.txt")).toBe("one");
    await fs.appendFile("/b.txt", "-three");
    expect(await fs.readFileText("/a.txt")).toBe("one-two");
    expect(await fs.readFileText("/b.txt")).toBe("one-three");
  });

  it("keeps a stream opened before an append unaffected by it", async () => {
    const fs = new InMemoryFs({ "/a.txt": "start" });
    const stream = await fs.readFile("/a.txt");
    await fs.appendFile("/a.txt", "-more");
    expect(dec.decode(await collectBytes(stream))).toBe("start");
    expect(await fs.readFileText("/a.txt")).toBe("start-more");
  });

  it("openFileAppender writes immediately and creates missing files", async () => {
    const fs = new InMemoryFs();
    const appender = await fs.openFileAppender("/dir/out.txt");
    await appender.append(enc.encode("a"));
    expect(await fs.readFileText("/dir/out.txt")).toBe("a");
    await appender.append(enc.encode("b"));
    expect(await fs.readFileText("/dir/out.txt")).toBe("ab");
    await appender.close();
  });

  it("openFileAppender keeps writing to the open entry after unlink (fd semantics)", async () => {
    const fs = new InMemoryFs({ "/f": "x" });
    const appender = await fs.openFileAppender("/f");
    await fs.rm("/f");
    await appender.append(enc.encode("y"));
    await appender.close();
    expect(await fs.exists("/f")).toBe(false);
  });

  it("openFileAppender rejects directories", async () => {
    const fs = new InMemoryFs();
    await fs.mkdir("/d");
    await expect(fs.openFileAppender("/d")).rejects.toThrow(/EISDIR/);
  });
});
