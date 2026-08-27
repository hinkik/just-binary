/**
 * Shared glob pattern matching utilities.
 *
 * Used by grep, find, and other commands that need glob matching.
 */

import { createUserRegex, type RegexLike } from "../regex/index.js";

/**
 * Compiled-regex cache for glob patterns (key: pattern + flags).
 *
 * Bounded, because the key space is caller data: patterns reach here from
 * `find -name` and grep's include/exclude, so a caller that builds a pattern
 * per item ("find -name <id>-?") mints a new entry each time. This module is
 * process-scoped, so an unbounded map here outlives every shell and grows for
 * the life of the host process. Compiled entries are a few KB apiece.
 *
 * Least-recently-used is evicted on overflow: reuse dominates real workloads
 * (a handful of patterns applied to many names), and a cache miss only costs
 * recompilation, never correctness.
 */
const MAX_GLOB_REGEX_CACHE = 1000;
const globRegexCache = new Map<string, RegexLike>();

export interface MatchGlobOptions {
  /** Case-insensitive matching */
  ignoreCase?: boolean;
  /** Strip surrounding quotes from pattern before matching */
  stripQuotes?: boolean;
}

/**
 * Match a filename against a glob pattern.
 *
 * Supports:
 * - `*` matches any sequence of characters
 * - `?` matches any single character
 * - `[...]` character classes
 *
 * @param name - The filename to test
 * @param pattern - The glob pattern
 * @param options - Matching options
 * @returns true if the name matches the pattern
 */
export function matchGlob(
  name: string,
  pattern: string,
  options?: MatchGlobOptions | boolean,
): boolean {
  // Support legacy signature: matchGlob(name, pattern, ignoreCase)
  // @banned-pattern-ignore: options object with known structure (ignoreCase, stripQuotes, etc.)
  const opts: MatchGlobOptions =
    typeof options === "boolean" ? { ignoreCase: options } : (options ?? {});

  let cleanPattern = pattern;

  // Strip surrounding quotes if requested
  if (opts.stripQuotes) {
    if (
      (cleanPattern.startsWith('"') && cleanPattern.endsWith('"')) ||
      (cleanPattern.startsWith("'") && cleanPattern.endsWith("'"))
    ) {
      cleanPattern = cleanPattern.slice(1, -1);
    }
  }

  // Build cache key
  const cacheKey = opts.ignoreCase ? `i:${cleanPattern}` : cleanPattern;
  const re = getCachedGlobRegex(cacheKey, cleanPattern, opts.ignoreCase);

  return re.test(name);
}

/**
 * Look up (or compile) the regex for a cache key, keeping the cache bounded.
 *
 * A hit re-inserts the entry so Map iteration order stays least-recent-first,
 * which makes the eviction below LRU rather than insertion-order.
 */
function getCachedGlobRegex(
  cacheKey: string,
  pattern: string,
  ignoreCase?: boolean,
): RegexLike {
  const cached = globRegexCache.get(cacheKey);
  if (cached !== undefined) {
    globRegexCache.delete(cacheKey);
    globRegexCache.set(cacheKey, cached);
    return cached;
  }

  const re = globToRegex(pattern, ignoreCase);
  globRegexCache.set(cacheKey, re);
  if (globRegexCache.size > MAX_GLOB_REGEX_CACHE) {
    const oldest = globRegexCache.keys().next();
    if (!oldest.done) globRegexCache.delete(oldest.value);
  }
  return re;
}

/**
 * Convert a glob pattern to a RegExp.
 */
function globToRegex(pattern: string, ignoreCase?: boolean): RegexLike {
  let regex = "^";

  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      regex += ".*";
    } else if (c === "?") {
      regex += ".";
    } else if (c === "[") {
      // Character class - find closing bracket
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== "]") j++;
      regex += pattern.slice(i, j + 1);
      i = j;
    } else if (
      c === "." ||
      c === "+" ||
      c === "^" ||
      c === "$" ||
      c === "{" ||
      c === "}" ||
      c === "(" ||
      c === ")" ||
      c === "|" ||
      c === "\\"
    ) {
      regex += `\\${c}`;
    } else {
      regex += c;
    }
  }

  regex += "$";
  return createUserRegex(regex, ignoreCase ? "i" : "");
}
