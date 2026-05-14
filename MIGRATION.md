# Uint8Array → ByteStream Migration Guide

Hard cut, no backwards compatibility. Old code is being deleted.

## New types

- `ByteStream = ReadableStream<Uint8Array>` — exported from `src/utils/stream.ts`.
- `ExecResult.stdout: ByteStream` (was `Uint8Array`)
- `ExecResult.stderr: ByteStream` (was `Uint8Array`)
- `CommandContext.stdin: ByteStream` (was `Uint8Array`)
- `CommandExecOptions.stdin?: ByteStream` (was `Uint8Array`)
- `ExecOptions.stdin?: ByteStream` (was `Uint8Array`)

## Stream utilities (`src/utils/stream.ts`)

```ts
import {
  ByteStream, CHUNK_SIZE,
  emptyStream, fromBytes, fromChunks, fromString,
  collectBytes, collectText,
  concatStreams, teeStream,
  streamChunks, streamLines,
  makeChunkSink, drain, mapChunks,
} from "../utils/stream.js"; // adjust path
```

## Filesystem (`src/fs/interface.ts`)

- `readFile(path): Promise<ByteStream>` — streams; replaces both old `readFile(string)` and `readFileBuffer`.
- `readFileText(path, encoding?): Promise<string>` — convenience for small/text content.
- `writeFile(path, content: ByteStream | Uint8Array | string, options?)` — accepts any.
- `appendFile(path, content: ByteStream | Uint8Array | string, options?)` — accepts any.
- `FileEntry.content` is removed; replaced by `FileEntry.chunks: Uint8Array[]` and `FileEntry.size: number`.
- `readFileBuffer` is **REMOVED** — call `collectBytes(await fs.readFile(p))` if you really need bytes.

## Env values stay `Uint8Array`

`Map<string, Uint8Array>` for env is unchanged — env values are small and need random access. `utils/bytes.ts` (encode/decode/concat/envGet/envSet/EMPTY) stays.

## Command args stay `Uint8Array[]`

`Command.execute(args: Uint8Array[], ctx)` is unchanged. Args are small.

## Migration patterns

### Reading stdin

```ts
// Old:
const text = decode(ctx.stdin);
const bytes = ctx.stdin;

// New (full buffer — for sort/awk/sed/etc):
const text = await collectText(ctx.stdin);
const bytes = await collectBytes(ctx.stdin);

// New (line-streaming — for grep/head/wc):
for await (const lineBytes of streamLines(ctx.stdin)) {
  // process line
}

// New (chunk-streaming — for cat/tee/tr-byte):
for await (const chunk of streamChunks(ctx.stdin)) { ... }
```

### Producing stdout/stderr

```ts
// Old:
return { stdout: encode(output), stderr: EMPTY, exitCode: 0 };

// New:
return { stdout: fromString(output), stderr: emptyStream(), exitCode: 0 };

// Old:
return { stdout: bytes, stderr: encode(errMsg), exitCode: 1 };

// New:
return { stdout: fromBytes(bytes), stderr: fromString(errMsg), exitCode: 1 };

// Multiple chunks:
return { stdout: fromChunks(chunks), stderr: emptyStream(), exitCode: 0 };
```

### Helper file `src/interpreter/helpers/result.ts`

Update `OK`, `failureWithExit`, `successText`, `failure`, `result`, etc. to produce streams:

```ts
export const OK: ExecResult = {
  stdout: emptyStream(),
  stderr: emptyStream(),
  exitCode: 0,
};
// Note: emptyStream() creates a new stream each call — OK should be a getter or factory.
// Recommend: export const OK = () => ({ stdout: emptyStream(), stderr: emptyStream(), exitCode: 0 });
```

**Important**: Streams are single-use. A shared `OK` constant breaks the second time it's consumed. Either return a fresh object each time, or document the constraint and audit usage.

### Concatenating outputs (e.g., timing in pipeline)

```ts
// Old:
stderr: concat(lastResult.stderr, encode(timingOutput))

// New:
stderr: concatStreams(lastResult.stderr, fromString(timingOutput))
```

### Filesystem read/write

```ts
// Old:
const text = await fs.readFile(path);
const bytes = await fs.readFileBuffer(path);

// New:
const text = await fs.readFileText(path);
const bytes = await collectBytes(await fs.readFile(path));
const stream = await fs.readFile(path); // and consume chunks

// Old:
await fs.writeFile(path, "hello");
await fs.writeFile(path, someUint8Array);

// New (both still work — string and Uint8Array still accepted):
await fs.writeFile(path, "hello");
await fs.writeFile(path, someUint8Array);
await fs.writeFile(path, someStream); // also accepted now
```

### Tests

```ts
// Old:
const r = toText(await bash.exec("echo hi"));
expect(r.stdout).toBe("hi\n");

// New (toText is now async):
const r = await toText(await bash.exec("echo hi"));
expect(r.stdout).toBe("hi\n");

// Direct stdin assertions:
// Old:
const r = await bash.exec("cat", { stdin: encode("data") });
// New:
const r = await bash.exec("cat", { stdin: fromString("data") });

// Old:
expect(result.stdout).toEqual(new Uint8Array([...]));
// New:
expect(await collectBytes(result.stdout)).toEqual(new Uint8Array([...]));
```

### Pipeline (`src/interpreter/pipeline-execution.ts`)

- `stdin` flowing between commands is now `ByteStream`.
- `EMPTY` (Uint8Array) → `emptyStream()`.
- `concat(stderr, stdout)` for `|&` → `concatStreams(stderr, stdout)`.
- After consuming a result's stdout to pipe forward, that stream is consumed; the "last command's stdout" must be the actual stream (not consumed).
- PIPESTATUS, pipefail, timing logic stays the same.

### One-shot stream reuse hazard

A `ByteStream` can only be read once. If a command's stdout needs to go to multiple places (e.g., redirection AND pipe), use `teeStream(s)`. Audit redirection code carefully.

### `OK` constant pattern

```ts
// Bad: shared instance, second read fails
export const OK: ExecResult = { stdout: emptyStream(), stderr: emptyStream(), exitCode: 0 };

// Good: factory
export function ok(): ExecResult {
  return { stdout: emptyStream(), stderr: emptyStream(), exitCode: 0 };
}
```

Convert all `return OK;` to `return ok();`.

## InMemoryFs chunked storage

`FileEntry.chunks: Uint8Array[]` — each chunk ≤ `CHUNK_SIZE` (64 KiB).
- `readFile()` returns `fromChunks(entry.chunks)`.
- `writeFile()` chunked-writes content into a new chunks array.
- `appendFile()` extends the chunks array.
- `stat().size` is `entry.size` (cached).

## Don't break

- Env Map<string, Uint8Array> — unchanged.
- Command args Uint8Array[] — unchanged.
- IO state file descriptors — unchanged.
- `src/utils/bytes.ts` — keep encode/decode/concat/EMPTY/envGet/envSet/createStringEnvAdapter/decodeArgs/isEmpty/trimTrailingNewlines.
