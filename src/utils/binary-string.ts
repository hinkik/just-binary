/**
 * Convert a Uint8Array to a binary string (latin1), chunked to avoid
 * hitting the JS engine's maximum function-argument limit (~65k–125k).
 */
const CHUNK = 8192;

export function uint8ToBinaryString(bytes: Uint8Array): string {
  if (bytes.length <= CHUNK) {
    return String.fromCharCode.apply(null, bytes as unknown as number[]);
  }
  let result = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    result += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + CHUNK) as unknown as number[],
    );
  }
  return result;
}
