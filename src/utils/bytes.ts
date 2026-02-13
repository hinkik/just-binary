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

/**
 * Encode a string as Latin-1 (ISO 8859-1) bytes: charCode → byte, 1:1.
 * Use this when the string was built with String.fromCharCode() for raw byte
 * values (e.g. echo/printf \xHH escapes) and must NOT be re-encoded as UTF-8.
 */
function encodeLatin1(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Encode a mixed string containing both raw byte values (0x80-0xFF from
 * String.fromCharCode, e.g. \xHH / \0NNN escapes) and true Unicode characters
 * (code points > 0xFF from String.fromCodePoint, e.g. \u / \U escapes).
 *
 * - Code points 0x00-0x7F: emitted as a single byte (ASCII)
 * - Code points 0x80-0xFF: emitted as a single byte (raw, not UTF-8 encoded)
 * - Code points > 0xFF: UTF-8 encoded (true Unicode characters)
 */
export function encodeMixed(s: string): Uint8Array {
  // Fast path: if all chars are <= 0xFF, use Latin-1 encoding
  let allLatin1 = true;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0xff) {
      allLatin1 = false;
      break;
    }
  }
  if (allLatin1) {
    return encodeLatin1(s);
  }

  // Mixed path: combine raw bytes and UTF-8 encoded segments
  const parts: Uint8Array[] = [];
  let utf8Start = -1; // start index of a segment needing UTF-8 encoding

  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0xff) {
      // Flush any pending UTF-8 segment
      if (utf8Start >= 0) {
        parts.push(encoder.encode(s.slice(utf8Start, i)) as Uint8Array);
        utf8Start = -1;
      }
      // Emit raw byte
      parts.push(new Uint8Array([code]));
    } else {
      // This char needs UTF-8 encoding; accumulate in a segment
      // Handle surrogate pairs (emoji etc.)
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          // Surrogate pair - keep both in the UTF-8 segment
          if (utf8Start < 0) utf8Start = i;
          i++; // skip the low surrogate
          continue;
        }
      }
      if (utf8Start < 0) utf8Start = i;
    }
  }

  // Flush any remaining UTF-8 segment
  if (utf8Start >= 0) {
    parts.push(encoder.encode(s.slice(utf8Start)) as Uint8Array);
  }

  // Concatenate all parts
  const totalLen = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Check if a byte array is empty (zero length) */
export function isEmpty(bytes: Uint8Array): boolean {
  return bytes.length === 0;
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
