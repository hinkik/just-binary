/**
 * Word Part Helper Functions
 *
 * Provides common operations on WordPart types to eliminate duplication
 * across expansion.ts and word-parser.ts.
 */

import type { WordPart } from "../../ast/types.js";
import { decode } from "../../utils/bytes.js";

/**
 * Get the literal string value from a word part.
 * Returns the value for Literal, SingleQuoted, Escaped, and Bytes parts.
 * Returns null for complex parts that require expansion.
 */
export function getLiteralValue(part: WordPart): string | null {
  switch (part.type) {
    case "Literal":
      return part.value;
    case "SingleQuoted":
      return part.value;
    case "Escaped":
      return part.value;
    case "Bytes":
      return decode(part.value);
    default:
      return null;
  }
}

/**
 * Check if a word part is "quoted" - meaning glob characters should be treated literally.
 * A part is quoted if it is:
 * - SingleQuoted
 * - Escaped
 * - DoubleQuoted (entirely quoted)
 * - Bytes (from $'...' ANSI-C quoting)
 * - Literal with empty value (doesn't affect quoting)
 */
export function isQuotedPart(part: WordPart): boolean {
  switch (part.type) {
    case "SingleQuoted":
    case "Escaped":
    case "DoubleQuoted":
    case "Bytes":
      return true;
    case "Literal":
      // Empty literals don't affect quoting
      return part.value === "";
    default:
      // Unquoted expansions like $var are not quoted
      return false;
  }
}
