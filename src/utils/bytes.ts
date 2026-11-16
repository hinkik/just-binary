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

/**
 * Strings up to this length are encoded by hand when they are ASCII.
 * TextEncoder.encode has a fixed cost of several hundred nanoseconds per call
 * in Node, which dwarfs the work for the short strings the interpreter
 * encodes constantly (words, variable values, small outputs).
 */
const SHORT_ASCII_LIMIT = 64;

/** Encode a string to UTF-8 bytes */
export function encode(s: string): Uint8Array {
  const length = s.length;
  if (length === 0) return EMPTY;
  if (length <= SHORT_ASCII_LIMIT) {
    const out = new Uint8Array(length);
    let i = 0;
    for (; i < length; i++) {
      const code = s.charCodeAt(i);
      if (code > 0x7f) break;
      out[i] = code;
    }
    if (i === length) return out;
  }
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

/** Convenience: decode an array of Uint8Array args to string[] via UTF-8 */
export function decodeArgs(args: Uint8Array[]): string[] {
  return args.map((a) => decoder.decode(a));
}

// ============================================================================
// Env Map Helpers
// ============================================================================
// Convenience wrappers for working with Map<string, Uint8Array> environments.
// Variable *names* are always strings; only *values* are Uint8Array.

/**
 * One stored value. Shell values are text nearly always, so the string is the
 * working form; bytes are kept when a value was stored as bytes (it may not be
 * valid UTF-8) and are otherwise derived on first request. Entries are never
 * mutated to a different value, so copies of an EnvMap can share them.
 */
interface EnvEntry {
  text: string | undefined;
  bytes: Uint8Array | undefined;
}

/**
 * The shell's variable store: a Map<string, Uint8Array> that also keeps each
 * value's decoded text.
 *
 * Reading and writing a variable through the plain Map interface costs a UTF-8
 * encode or decode every time, and the interpreter does that several times per
 * command. getText/setText read and write the text form directly; get/set keep
 * the byte contract for callers (and embedders' commands) that want bytes.
 */
export class EnvMap extends Map<string, Uint8Array> {
  private entries_: Map<string, EnvEntry>;

  constructor(source?: Iterable<readonly [string, Uint8Array]> | null) {
    super();
    if (source instanceof EnvMap) {
      this.entries_ = new Map(source.entries_);
    } else {
      this.entries_ = new Map();
      if (source) {
        for (const [key, value] of source) {
          this.entries_.set(key, { text: undefined, bytes: value });
        }
      }
    }
  }

  /** An independent copy. Values are shared, not re-encoded. */
  clone(): EnvMap {
    return new EnvMap(this);
  }

  getText(key: string): string | undefined {
    const entry = this.entries_.get(key);
    if (entry === undefined) return undefined;
    if (entry.text === undefined) {
      entry.text = decoder.decode(entry.bytes);
    }
    return entry.text;
  }

  setText(key: string, value: string): this {
    this.entries_.set(key, { text: value, bytes: undefined });
    return this;
  }

  override get(key: string): Uint8Array | undefined {
    const entry = this.entries_.get(key);
    if (entry === undefined) return undefined;
    if (entry.bytes === undefined) {
      entry.bytes = encode(entry.text as string);
    }
    return entry.bytes;
  }

  override set(key: string, value: Uint8Array): this {
    this.entries_.set(key, { text: undefined, bytes: value });
    return this;
  }

  override has(key: string): boolean {
    return this.entries_.has(key);
  }

  override delete(key: string): boolean {
    return this.entries_.delete(key);
  }

  override clear(): void {
    this.entries_.clear();
  }

  override get size(): number {
    return this.entries_.size;
  }

  override keys(): MapIterator<string> {
    return this.entries_.keys();
  }

  override *values(): MapIterator<Uint8Array> {
    for (const key of this.entries_.keys()) {
      yield this.get(key) as Uint8Array;
    }
  }

  override *entries(): MapIterator<[string, Uint8Array]> {
    for (const key of this.entries_.keys()) {
      yield [key, this.get(key) as Uint8Array];
    }
  }

  override forEach(
    callbackfn: (
      value: Uint8Array,
      key: string,
      map: Map<string, Uint8Array>,
    ) => void,
    thisArg?: unknown,
  ): void {
    for (const key of this.entries_.keys()) {
      callbackfn.call(thisArg, this.get(key) as Uint8Array, key, this);
    }
  }

  override [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
    return this.entries();
  }
}

/** An independent copy of an env map, keeping its text cache when it has one. */
export function cloneEnv(
  env: Map<string, Uint8Array>,
): Map<string, Uint8Array> {
  return env instanceof EnvMap ? env.clone() : new Map(env);
}

/** Get an env value as a decoded string, or return the fallback (default "") */
export function envGet(
  env: Map<string, Uint8Array>,
  key: string,
  fallback = "",
): string {
  if (env instanceof EnvMap) {
    const text = env.getText(key);
    return text !== undefined ? text : fallback;
  }
  const v = env.get(key);
  return v !== undefined ? decoder.decode(v) : fallback;
}

/** Get an env value as a decoded string, or undefined when it is not set. */
export function envGetOptional(
  env: Map<string, Uint8Array>,
  key: string,
): string | undefined {
  if (env instanceof EnvMap) {
    return env.getText(key);
  }
  const v = env.get(key);
  return v !== undefined ? decoder.decode(v) : undefined;
}

/** Set an env value from a string (encodes to UTF-8) */
export function envSet(
  env: Map<string, Uint8Array>,
  key: string,
  value: string,
): void {
  if (env instanceof EnvMap) {
    env.setText(key, value);
    return;
  }
  env.set(key, encode(value));
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
      return envGetOptional(backing, key);
    },
    set(key: string, value: string): Map<string, string> {
      envSet(backing, key, value);
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
