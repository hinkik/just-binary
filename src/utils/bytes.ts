/**
 * Byte utilities for the Uint8Array-based I/O pipeline.
 *
 * The interpreter uses Uint8Array for all I/O (stdout, stderr, stdin).
 * Commands that process text decode at entry and encode at exit.
 * Redirections write bytes directly — no encoding guessing.
 *
 * Note: Explicit return type annotations are required on encode, concat,
 * and trimTrailingNewlines because TS 5.7+ made Uint8Array generic over
 * its buffer type. Without annotations, TextEncoder.encode() and
 * Uint8Array.prototype.subarray() infer Uint8Array<ArrayBufferLike>,
 * which is not assignable to the Uint8Array (= Uint8Array<ArrayBuffer>)
 * used in ExecResult and other interfaces.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Empty byte array — reuse instead of allocating new Uint8Array(0) */
export const EMPTY: Uint8Array = new Uint8Array(0);

/** Encode a string to UTF-8 bytes */
export function encode(s: string): Uint8Array {
  // TextEncoder.encode returns Uint8Array<ArrayBufferLike> in TS 5.7+
  return encoder.encode(s) as Uint8Array;
}

/** Decode UTF-8 bytes to a string */
export function decode(bytes: Uint8Array): string {
  return decoder.decode(bytes);
}

/** Concatenate two byte arrays. Fast path: if either is empty, return the other without copying. */
export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b as Uint8Array;
  if (b.length === 0) return a as Uint8Array;
  const result = new Uint8Array(a.length + b.length);
  result.set(a);
  result.set(b, a.length);
  return result as Uint8Array;
}

/** Check if a byte array is empty (zero length) */
export function isEmpty(bytes: Uint8Array): boolean {
  return bytes.length === 0;
}

/** Convenience: decode an array of Uint8Array args to string[] via UTF-8 */
export function decodeArgs(args: Uint8Array[]): string[] {
  return args.map((a) => decoder.decode(a));
}

// ============================================================================
// Env Map Helpers
// ============================================================================
// Convenience wrappers for working with Map<string, Uint8Array> environments.
// Variable *names* are always strings; only *values* are Uint8Array.

/** Get an env value as a decoded string, or return the fallback (default "") */
export function envGet(
  env: Map<string, Uint8Array>,
  key: string,
  fallback = "",
): string {
  const v = env.get(key);
  return v !== undefined ? decoder.decode(v) : fallback;
}

/** Set an env value from a string (encodes to UTF-8) */
export function envSet(
  env: Map<string, Uint8Array>,
  key: string,
  value: string,
): void {
  env.set(key, encoder.encode(value) as Uint8Array);
}

/**
 * Create a Map<string, string> adapter over a Map<string, Uint8Array>.
 * Decodes on read and encodes on write, so mutations propagate to the backing store.
 * Used at the boundary between the Uint8Array-based interpreter env and the
 * string-based Command interface (until Phase 4 migrates commands).
 */
export function createStringEnvAdapter(
  backing: Map<string, Uint8Array>,
): Map<string, string> {
  return {
    get(key: string): string | undefined {
      const v = backing.get(key);
      return v !== undefined ? decoder.decode(v) : undefined;
    },
    set(key: string, value: string): Map<string, string> {
      backing.set(key, encoder.encode(value) as Uint8Array);
      return this;
    },
    has(key: string): boolean {
      return backing.has(key);
    },
    delete(key: string): boolean {
      return backing.delete(key);
    },
    get size(): number {
      return backing.size;
    },
    clear(): void {
      backing.clear();
    },
    keys(): MapIterator<string> {
      return backing.keys();
    },
    *values(): MapIterator<string> {
      for (const v of backing.values()) {
        yield decoder.decode(v);
      }
    },
    *entries(): MapIterator<[string, string]> {
      for (const [k, v] of backing.entries()) {
        yield [k, decoder.decode(v)];
      }
    },
    forEach(
      callbackfn: (
        value: string,
        key: string,
        map: Map<string, string>,
      ) => void,
    ): void {
      for (const [k, v] of backing) {
        callbackfn(decoder.decode(v), k, this);
      }
    },
    [Symbol.iterator](): MapIterator<[string, string]> {
      return this.entries();
    },
    [Symbol.toStringTag]: "StringEnvAdapter",
  } as Map<string, string>;
}

/** Remove trailing newline bytes (0x0A) from the end */
export function trimTrailingNewlines(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0x0a) {
    end--;
  }
  if (end === bytes.length) return bytes;
  if (end === 0) return EMPTY;
  // subarray returns Uint8Array<ArrayBufferLike> in TS 5.7+
  return bytes.subarray(0, end) as Uint8Array;
}
