/**
 * Environment variable helpers for safe Map-to-Record conversion.
 *
 * These helpers prevent prototype pollution by creating null-prototype objects
 * when converting environment variable Maps to Records.
 */

import { decode } from "../utils/bytes.js";

/**
 * Convert a Map<string, Uint8Array> to a null-prototype Record<string, string>.
 *
 * This prevents prototype pollution attacks where user-controlled keys like
 * "__proto__", "constructor", or "hasOwnProperty" could access or modify
 * the Object prototype chain.
 *
 * @param env - The environment Map to convert
 * @returns A null-prototype object with the same key-value pairs
 */
export function mapToRecord(
  env: Map<string, Uint8Array>,
): Record<string, string>;
export function mapToRecord(env: Map<string, string>): Record<string, string>;
export function mapToRecord(
  env: Map<string, Uint8Array | string>,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of env) {
    result[key] = typeof value === "string" ? value : decode(value);
  }
  return result;
}

/**
 * Convert a Map<string, Uint8Array> to a null-prototype Record, with optional
 * additional properties to merge.
 *
 * @param env - The environment Map to convert
 * @param extra - Additional properties to merge into the result
 * @returns A null-prototype object with the combined key-value pairs
 */
export function mapToRecordWithExtras(
  env: Map<string, Uint8Array | string>,
  extra?: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of env) {
    result[key] = typeof value === "string" ? value : decode(value);
  }
  if (extra) {
    Object.assign(result, extra);
  }
  return result;
}

/**
 * Merge multiple objects into a null-prototype object.
 *
 * This prevents prototype pollution when merging user-controlled objects
 * (e.g., from JSON input in jq queries).
 *
 * @param objects - Objects to merge
 * @returns A null-prototype object with all properties merged
 */
export function mergeToNullPrototype<T extends object>(
  ...objects: T[]
): Record<string, unknown> {
  return Object.assign(Object.create(null), ...objects);
}
