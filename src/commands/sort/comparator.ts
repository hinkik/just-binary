// Comparator functions for sort command

import type { KeySpec, SortOptions } from "./types.js";

// Human-readable size suffixes (case insensitive) - Map prevents prototype pollution
const SIZE_SUFFIXES = new Map<string, number>([
  ["", 1],
  ["k", 1024],
  ["m", 1024 ** 2],
  ["g", 1024 ** 3],
  ["t", 1024 ** 4],
  ["p", 1024 ** 5],
  ["e", 1024 ** 6],
]);

// Month names for -M - Map prevents prototype pollution
const MONTHS = new Map<string, number>([
  ["jan", 1],
  ["feb", 2],
  ["mar", 3],
  ["apr", 4],
  ["may", 5],
  ["jun", 6],
  ["jul", 7],
  ["aug", 8],
  ["sep", 9],
  ["oct", 10],
  ["nov", 11],
  ["dec", 12],
]);

/**
 * Parse a human-readable size like "1K", "2.5M", "3G"
 */
function parseHumanSize(s: string): number {
  const trimmed = s.trim();
  const match = trimmed.match(
    /^([+-]?\d*\.?\d+)\s*([kmgtpeKMGTPE])?[iI]?[bB]?$/,
  );
  if (!match) {
    // Try to parse as plain number
    const num = parseFloat(trimmed);
    return Number.isNaN(num) ? 0 : num;
  }
  const num = parseFloat(match[1]);
  const suffix = (match[2] || "").toLowerCase();
  const multiplier = SIZE_SUFFIXES.get(suffix) ?? 1;
  return num * multiplier;
}

/**
 * Parse month name and return sort order (0 for unknown)
 */
function parseMonth(s: string): number {
  const trimmed = s.trim().toLowerCase().slice(0, 3);
  return MONTHS.get(trimmed) ?? 0;
}

/**
 * Compare version strings naturally (e.g., "1.2" < "1.10")
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split(/(\d+)/);
  const partsB = b.split(/(\d+)/);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const partA = partsA[i] || "";
    const partB = partsB[i] || "";

    // Check if both parts are numeric
    const numA = /^\d+$/.test(partA) ? parseInt(partA, 10) : null;
    const numB = /^\d+$/.test(partB) ? parseInt(partB, 10) : null;

    if (numA !== null && numB !== null) {
      // Both numeric - compare as numbers
      if (numA !== numB) return numA - numB;
    } else {
      // At least one is non-numeric - compare as strings
      if (partA !== partB) return collator.compare(partA, partB);
    }
  }
  return 0;
}

/**
 * Apply dictionary order: keep only alphanumeric and blanks
 */
function toDictionaryOrder(s: string): string {
  return s.replace(/[^a-zA-Z0-9\s]/g, "");
}

/**
 * Extract key value from a line based on key specification
 */
function extractKeyValue(
  line: string,
  key: KeySpec,
  delimiter: string | null,
): string {
  // Split line into fields
  const splitPattern = delimiter !== null ? delimiter : /\s+/;
  const fields = line.split(splitPattern);

  // Get start field (0-indexed internally)
  const startFieldIdx = key.startField - 1;
  if (startFieldIdx >= fields.length) {
    return "";
  }

  // If no end field specified, use just the start field
  if (key.endField === undefined) {
    let field = fields[startFieldIdx] || "";

    // Handle character position within field
    if (key.startChar !== undefined) {
      field = field.slice(key.startChar - 1);
    }

    // Handle ignore leading blanks
    if (key.ignoreLeading) {
      field = field.trimStart();
    }

    return field;
  }

  // Range of fields
  const endFieldIdx = Math.min(key.endField - 1, fields.length - 1);

  // Build the key value from multiple fields
  let result = "";

  for (let i = startFieldIdx; i <= endFieldIdx && i < fields.length; i++) {
    let field = fields[i] || "";

    if (i === startFieldIdx && key.startChar !== undefined) {
      // Start character position in first field
      field = field.slice(key.startChar - 1);
    }

    if (i === endFieldIdx && key.endChar !== undefined) {
      // End character position in last field
      const endIdx =
        i === startFieldIdx && key.startChar !== undefined
          ? key.endChar - key.startChar + 1
          : key.endChar;
      field = field.slice(0, endIdx);
    }

    if (i > startFieldIdx) {
      // Add delimiter between fields
      result += delimiter || " ";
    }
    result += field;
  }

  // Handle ignore leading blanks
  if (key.ignoreLeading) {
    result = result.trimStart();
  }

  return result;
}

interface CompareOptions {
  numeric?: boolean;
  ignoreCase?: boolean;
  humanNumeric?: boolean;
  versionSort?: boolean;
  dictionaryOrder?: boolean;
  monthSort?: boolean;
}

/**
 * A value made ready for comparison under one set of options: its folded
 * text and, for the numeric modes, its number. A sort compares each line
 * many times, so this work is done once per line rather than per comparison.
 */
interface PreparedValue {
  text: string;
  number: number;
}

function prepareValue(value: string, opts: CompareOptions): PreparedValue {
  let text = value;

  // Apply dictionary order first (removes non-alphanumeric)
  if (opts.dictionaryOrder) {
    text = toDictionaryOrder(text);
  }

  // Apply case folding
  if (opts.ignoreCase) {
    text = text.toLowerCase();
  }

  let number = 0;
  if (opts.monthSort) {
    number = parseMonth(text);
  } else if (opts.humanNumeric) {
    // Human numeric sort (1K, 2M, etc.)
    number = parseHumanSize(text);
  } else if (!opts.versionSort && opts.numeric) {
    number = parseFloat(text) || 0;
  }
  return { text, number };
}

// Same ordering as String.prototype.localeCompare with no arguments, without
// setting up a collator on every call.
const collator = new Intl.Collator();

function compareText(a: string, b: string): number {
  return a === b ? 0 : collator.compare(a, b);
}

/**
 * Compare two prepared values, handling various sort modes
 */
function comparePrepared(
  a: PreparedValue,
  b: PreparedValue,
  opts: CompareOptions,
): number {
  if (opts.monthSort || opts.humanNumeric) {
    return a.number - b.number;
  }
  if (opts.versionSort) {
    return compareVersions(a.text, b.text);
  }
  if (opts.numeric) {
    return a.number - b.number;
  }
  return compareText(a.text, b.text);
}

/**
 * How to order lines under a set of options: `prepare` derives a line's
 * comparison keys once, `compare` orders two lines given their keys.
 */
interface LineOrdering<K> {
  prepare(line: string): K;
  compare(keyA: K, lineA: string, keyB: K, lineB: string): number;
}

function createOrdering(
  options: SortOptions,
): LineOrdering<PreparedValue> | LineOrdering<PreparedValue[]> {
  const {
    keys,
    fieldDelimiter,
    numeric: globalNumeric,
    ignoreCase: globalIgnoreCase,
    reverse: globalReverse,
    humanNumeric: globalHumanNumeric,
    versionSort: globalVersionSort,
    dictionaryOrder: globalDictionaryOrder,
    monthSort: globalMonthSort,
    ignoreLeadingBlanks: globalIgnoreLeadingBlanks,
    stable: globalStable,
  } = options;

  // Tiebreaker: use original lines unless stable sort
  const tiebreak = (a: string, b: string): number => {
    if (globalStable) return 0;
    const tiebreaker = compareText(a, b);
    return globalReverse ? -tiebreaker : tiebreaker;
  };

  if (keys.length === 0) {
    // No keys specified: compare whole lines
    const opts: CompareOptions = {
      numeric: globalNumeric,
      ignoreCase: globalIgnoreCase,
      humanNumeric: globalHumanNumeric,
      versionSort: globalVersionSort,
      dictionaryOrder: globalDictionaryOrder,
      monthSort: globalMonthSort,
    };
    const ordering: LineOrdering<PreparedValue> = {
      prepare: (line) =>
        // Apply ignore leading blanks globally
        prepareValue(globalIgnoreLeadingBlanks ? line.trimStart() : line, opts),
      compare: (keyA, lineA, keyB, lineB) => {
        const result = comparePrepared(keyA, keyB, opts);
        if (result !== 0) {
          return globalReverse ? -result : result;
        }
        return tiebreak(lineA, lineB);
      },
    };
    return ordering;
  }

  // Per-key modifiers fall back to the global options
  const keyOptions: CompareOptions[] = keys.map((key) => ({
    numeric: key.numeric ?? globalNumeric,
    ignoreCase: key.ignoreCase ?? globalIgnoreCase,
    humanNumeric: key.humanNumeric ?? globalHumanNumeric,
    versionSort: key.versionSort ?? globalVersionSort,
    dictionaryOrder: key.dictionaryOrder ?? globalDictionaryOrder,
    monthSort: key.monthSort ?? globalMonthSort,
  }));
  const keyReverse = keys.map((key) => key.reverse ?? globalReverse);

  const ordering: LineOrdering<PreparedValue[]> = {
    prepare: (line) => {
      // Apply ignore leading blanks globally
      const source = globalIgnoreLeadingBlanks ? line.trimStart() : line;
      return keys.map((key, i) => {
        let value = extractKeyValue(source, key, fieldDelimiter);
        // Apply per-key ignore leading blanks
        if (key.ignoreLeading) {
          value = value.trimStart();
        }
        return prepareValue(value, keyOptions[i]);
      });
    },
    compare: (valuesA, lineA, valuesB, lineB) => {
      // Compare by each key in order
      for (let i = 0; i < keys.length; i++) {
        const result = comparePrepared(valuesA[i], valuesB[i], keyOptions[i]);
        if (result !== 0) {
          return keyReverse[i] ? -result : result;
        }
      }
      // All keys equal, compare whole lines as tiebreaker unless stable
      return tiebreak(lineA, lineB);
    },
  };
  return ordering;
}

/**
 * Create a comparison function for sorting
 */
export function createComparator(
  options: SortOptions,
): (a: string, b: string) => number {
  const ordering = createOrdering(options) as LineOrdering<unknown>;
  return (a, b) =>
    ordering.compare(ordering.prepare(a), a, ordering.prepare(b), b);
}

/**
 * Sort lines in the order createComparator(options) defines. Each line's
 * keys are derived once, not once per comparison.
 */
export function sortLines(lines: string[], options: SortOptions): string[] {
  const ordering = createOrdering(options) as LineOrdering<unknown>;
  const entries = lines.map((line) => ({
    line,
    key: ordering.prepare(line),
  }));
  entries.sort((a, b) => ordering.compare(a.key, a.line, b.key, b.line));
  return entries.map((entry) => entry.line);
}

/**
 * Filter unique lines based on key values or whole line
 */
export function filterUnique(lines: string[], options: SortOptions): string[] {
  if (options.keys.length === 0) {
    // No keys - use whole line for uniqueness
    if (options.ignoreCase) {
      const seen = new Set<string>();
      return lines.filter((line) => {
        const key = line.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    return [...new Set(lines)];
  }

  // Use first key for uniqueness comparison
  const key = options.keys[0];
  const seen = new Set<string>();

  return lines.filter((line) => {
    let keyVal = extractKeyValue(line, key, options.fieldDelimiter);
    if (key.ignoreCase ?? options.ignoreCase) {
      keyVal = keyVal.toLowerCase();
    }
    if (seen.has(keyVal)) return false;
    seen.add(keyVal);
    return true;
  });
}
