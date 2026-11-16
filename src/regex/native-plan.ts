/**
 * Deciding when a user-provided pattern may run on the platform's RegExp.
 *
 * RE2 matches in time linear in the input, which is why every user pattern
 * goes through it — but its JavaScript port is some fifty times slower than
 * the native engine. The native engine backtracks, so it may only be used
 * when two things hold:
 *
 *  1. It finds the same matches. RE2 and JavaScript differ on what `.`, `\s`,
 *     `$` under the m flag and repeated capture groups mean, among others.
 *     The pattern is parsed here and re-emitted in a form that means to the
 *     native engine what the original means to RE2; anything outside the
 *     constructs handled below is refused.
 *
 *  2. Its backtracking is bounded. Patterns with a repetition inside a
 *     repetition, or alternatives a repetition cannot tell apart by their
 *     first character, are refused outright: those are the shapes that take
 *     exponential time. What remains can still cost a polynomial in the input
 *     length, so the plan carries the longest input for which that stays
 *     under a fixed budget of steps. Longer inputs go to RE2.
 *
 * Refusing is always safe: the pattern then runs on RE2 exactly as before.
 */

/** Rough number of backtracking steps a single match attempt may cost. */
const STEP_BUDGET = 1e7;

/** A bounded repetition with a larger count is treated as unbounded. */
const BOUNDED_REPEAT_LIMIT = 64;

/** Cap on the constant factor from optional parts and overlapping branches. */
const MAX_CHOICE_FACTOR = 4096;

export interface NativePlan {
  /** Pattern source for `new RegExp(source, flags)`. */
  source: string;
  /** Flags for the native regex: always global and unicode. */
  flags: string;
  /** Inputs longer than this must use RE2. Infinity when unbounded. */
  maxInputLength: number;
  /** Number of capture groups. */
  groupCount: number;
}

class Refused extends Error {}

function refuse(): never {
  throw new Refused();
}

// ----------------------------------------------------------------------------
// Character sets, for telling whether two parts of a pattern can match the
// same character. ASCII is tracked exactly; everything above it is one bit.
// ----------------------------------------------------------------------------

const NON_ASCII = 128;

type CharSet = Uint8Array;

function emptySet(): CharSet {
  return new Uint8Array(129);
}

function overlaps(a: CharSet, b: CharSet): boolean {
  for (let i = 0; i < 129; i++) {
    if (a[i] !== 0 && b[i] !== 0) return true;
  }
  return false;
}

function union(a: CharSet, b: CharSet): CharSet {
  const out = emptySet();
  for (let i = 0; i < 129; i++) {
    out[i] = a[i] | b[i];
  }
  return out;
}

function addRange(set: CharSet, from: number, to: number): void {
  for (let c = from; c <= to && c < 128; c++) {
    set[c] = 1;
  }
  if (to >= 128) set[NON_ASCII] = 1;
}

function complement(set: CharSet): CharSet {
  const out = emptySet();
  for (let i = 0; i < 128; i++) {
    out[i] = set[i] === 0 ? 1 : 0;
  }
  // A negated class always admits some character above ASCII.
  out[NON_ASCII] = 1;
  return out;
}

/** Add the other case of every ASCII letter in the set. */
function foldCase(set: CharSet): void {
  for (let c = 65; c <= 90; c++) {
    if (set[c] !== 0 || set[c + 32] !== 0) {
      set[c] = 1;
      set[c + 32] = 1;
    }
  }
  // Under case folding `k` and `s` also match U+212A and U+017F.
  if (set[107] !== 0 || set[115] !== 0) set[NON_ASCII] = 1;
}

// ----------------------------------------------------------------------------
// Pattern tree
// ----------------------------------------------------------------------------

type Node =
  | { type: "char"; set: CharSet; source: string }
  | { type: "assertion"; source: string }
  | { type: "concat"; items: Node[] }
  | { type: "alternation"; items: Node[] }
  | { type: "group"; capturing: boolean; open: string; body: Node }
  | { type: "repeat"; min: number; max: number; lazy: boolean; body: Node };

function isNullable(node: Node): boolean {
  switch (node.type) {
    case "char":
      return false;
    case "assertion":
      return true;
    case "concat":
      return node.items.every(isNullable);
    case "alternation":
      return node.items.some(isNullable);
    case "group":
      return isNullable(node.body);
    case "repeat":
      return node.min === 0 || isNullable(node.body);
  }
}

/** The characters a match of `node` can start with. */
function firstSet(node: Node): CharSet {
  switch (node.type) {
    case "char":
      return node.set;
    case "assertion":
      return emptySet();
    case "concat": {
      let out = emptySet();
      for (const item of node.items) {
        out = union(out, firstSet(item));
        if (!isNullable(item)) break;
      }
      return out;
    }
    case "alternation": {
      let out = emptySet();
      for (const item of node.items) {
        out = union(out, firstSet(item));
      }
      return out;
    }
    case "group":
      return firstSet(node.body);
    case "repeat":
      return firstSet(node.body);
  }
}

function containsRepeat(node: Node): boolean {
  switch (node.type) {
    case "char":
    case "assertion":
      return false;
    case "concat":
    case "alternation":
      return node.items.some(containsRepeat);
    case "group":
      return containsRepeat(node.body);
    case "repeat":
      return true;
  }
}

function containsCapture(node: Node): boolean {
  switch (node.type) {
    case "char":
    case "assertion":
      return false;
    case "concat":
    case "alternation":
      return node.items.some(containsCapture);
    case "group":
      return node.capturing || containsCapture(node.body);
    case "repeat":
      return containsCapture(node.body);
  }
}

/** Every alternation inside must be decided by its first character. */
function alternationsAreDecidable(node: Node): boolean {
  switch (node.type) {
    case "char":
    case "assertion":
      return true;
    case "concat":
      return node.items.every(alternationsAreDecidable);
    case "group":
      return alternationsAreDecidable(node.body);
    case "repeat":
      return alternationsAreDecidable(node.body);
    case "alternation": {
      const firsts = node.items.map(firstSet);
      for (let i = 0; i < node.items.length; i++) {
        if (isNullable(node.items[i])) return false;
        for (let j = i + 1; j < node.items.length; j++) {
          if (overlaps(firsts[i], firsts[j])) return false;
        }
      }
      return node.items.every(alternationsAreDecidable);
    }
  }
}

// ----------------------------------------------------------------------------
// Parser
// ----------------------------------------------------------------------------

const HEX = /^[0-9a-fA-F]+$/;

/** A code point written so that it is itself in a unicode-mode pattern. */
function emitCodePoint(code: number): string {
  if (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122)
  ) {
    return String.fromCharCode(code);
  }
  return `\\u{${code.toString(16)}}`;
}

const DIGIT_RANGES: Array<[number, number]> = [[48, 57]];
const WORD_RANGES: Array<[number, number]> = [
  [48, 57],
  [65, 90],
  [95, 95],
  [97, 122],
];
// RE2's \s: tab, newline, form feed, carriage return, space.
const SPACE_RANGES: Array<[number, number]> = [
  [9, 10],
  [12, 13],
  [32, 32],
];

function rangesFor(letter: string): Array<[number, number]> | null {
  switch (letter) {
    case "d":
    case "D":
      return DIGIT_RANGES;
    case "w":
    case "W":
      return WORD_RANGES;
    case "s":
    case "S":
      return SPACE_RANGES;
    default:
      return null;
  }
}

function emitRanges(ranges: Array<[number, number]>): string {
  let out = "";
  for (const [from, to] of ranges) {
    out +=
      from === to
        ? emitCodePoint(from)
        : `${emitCodePoint(from)}-${emitCodePoint(to)}`;
  }
  return out;
}

const SIMPLE_ESCAPES = new Map<string, number>([
  ["n", 10],
  ["t", 9],
  ["r", 13],
  ["f", 12],
  ["v", 11],
]);

const ESCAPABLE_PUNCTUATION = "\\^$.|?*+()[]{}-/";

class Parser {
  private pos = 0;
  groupCount = 0;
  private readonly names = new Set<string>();

  constructor(
    private readonly pattern: string,
    private readonly ignoreCase: boolean,
    private readonly multiline: boolean,
    private readonly dotAll: boolean,
  ) {}

  parse(): Node {
    const node = this.parseAlternation();
    if (this.pos < this.pattern.length) refuse();
    return node;
  }

  private peek(): string {
    return this.pattern[this.pos] ?? "";
  }

  private parseAlternation(): Node {
    const items: Node[] = [this.parseConcat()];
    while (this.peek() === "|") {
      this.pos++;
      items.push(this.parseConcat());
    }
    return items.length === 1 ? items[0] : { type: "alternation", items };
  }

  private parseConcat(): Node {
    const items: Node[] = [];
    while (this.pos < this.pattern.length) {
      const c = this.peek();
      if (c === "|" || c === ")") break;
      items.push(this.parseQuantified());
    }
    return items.length === 1 ? items[0] : { type: "concat", items };
  }

  private parseQuantified(): Node {
    const atom = this.parseAtom();
    const c = this.peek();
    let min: number;
    let max: number;
    if (c === "*") {
      min = 0;
      max = Number.POSITIVE_INFINITY;
      this.pos++;
    } else if (c === "+") {
      min = 1;
      max = Number.POSITIVE_INFINITY;
      this.pos++;
    } else if (c === "?") {
      min = 0;
      max = 1;
      this.pos++;
    } else if (c === "{") {
      const counted = /^\{(\d+)(?:(,)(\d*))?\}/.exec(
        this.pattern.slice(this.pos),
      );
      if (counted === null) return atom;
      min = Number.parseInt(counted[1], 10);
      max =
        counted[2] === undefined
          ? min
          : counted[3] === ""
            ? Number.POSITIVE_INFINITY
            : Number.parseInt(counted[3], 10);
      // RE2 rejects counts above 1000; let it report that.
      if (min > 1000 || (max !== Number.POSITIVE_INFINITY && max > 1000)) {
        refuse();
      }
      if (max < min) refuse();
      this.pos += counted[0].length;
    } else {
      return atom;
    }
    if (atom.type === "assertion") refuse();
    let lazy = false;
    if (this.peek() === "?") {
      lazy = true;
      this.pos++;
    }
    // A second quantifier (`a**`, `a+{2}`) is an error or means something
    // engine-specific.
    const next = this.peek();
    if (next === "*" || next === "+" || next === "?") refuse();
    if (
      next === "{" &&
      /^\{\d+(?:,\d*)?\}/.test(this.pattern.slice(this.pos))
    ) {
      refuse();
    }
    return { type: "repeat", min, max, lazy, body: atom };
  }

  private charNode(code: number): Node {
    const set = emptySet();
    addRange(set, code, code);
    if (this.ignoreCase) {
      // Folding tables differ between engines beyond ASCII.
      if (code >= 128) refuse();
      foldCase(set);
    }
    return { type: "char", set, source: emitCodePoint(code) };
  }

  private classNode(ranges: Array<[number, number]>, negated: boolean): Node {
    let set = emptySet();
    for (const [from, to] of ranges) {
      addRange(set, from, to);
      if (this.ignoreCase && to >= 128) refuse();
    }
    if (this.ignoreCase) foldCase(set);
    if (negated) set = complement(set);
    return {
      type: "char",
      set,
      source: `[${negated ? "^" : ""}${emitRanges(ranges)}]`,
    };
  }

  private parseAtom(): Node {
    const c = this.peek();
    switch (c) {
      case "(":
        return this.parseGroup();
      case "[":
        return this.parseClass();
      case ".": {
        this.pos++;
        if (this.dotAll) {
          const set = complement(emptySet());
          return { type: "char", set, source: "[^]" };
        }
        return this.classNode([[10, 10]], true);
      }
      case "^":
        this.pos++;
        return {
          type: "assertion",
          // RE2's multiline ^ follows a newline only; JavaScript's also
          // follows \r and the Unicode line separators.
          source: this.multiline ? "(?<![^\\n])" : "^",
        };
      case "$":
        this.pos++;
        return {
          type: "assertion",
          source: this.multiline ? "(?![^\\n])" : "$",
        };
      case "\\":
        return this.parseEscape();
      case "*":
      case "+":
      case "?":
      case ")":
      case "":
        return refuse();
      default: {
        const code = this.pattern.codePointAt(this.pos) as number;
        this.pos += code > 0xffff ? 2 : 1;
        // An unpaired surrogate has no code point of its own.
        if (code >= 0xd800 && code <= 0xdfff) refuse();
        return this.charNode(code);
      }
    }
  }

  private parseEscape(): Node {
    this.pos++; // backslash
    const c = this.peek();
    if (c === "") refuse();
    this.pos++;
    if (c === "b" || c === "B") {
      // Under case folding JavaScript's word characters gain two letters
      // that RE2's word boundary does not know.
      if (this.ignoreCase) refuse();
      return { type: "assertion", source: `\\${c}` };
    }
    const ranges = rangesFor(c);
    if (ranges !== null) {
      return this.classNode(ranges, c === "D" || c === "W" || c === "S");
    }
    return this.charNode(this.parseEscapedCodePoint(c));
  }

  /** The code point of an escape whose letter `c` was just consumed. */
  private parseEscapedCodePoint(c: string): number {
    const simple = SIMPLE_ESCAPES.get(c);
    if (simple !== undefined) return simple;
    if (ESCAPABLE_PUNCTUATION.includes(c)) return c.charCodeAt(0);
    if (c === "0") {
      if (/[0-9]/.test(this.peek())) refuse();
      return 0;
    }
    if (c === "x") {
      const hex = this.pattern.slice(this.pos, this.pos + 2);
      if (hex.length !== 2 || !HEX.test(hex)) refuse();
      this.pos += 2;
      return Number.parseInt(hex, 16);
    }
    if (c === "u") {
      const hex = this.pattern.slice(this.pos, this.pos + 4);
      if (hex.length !== 4 || !HEX.test(hex)) refuse();
      this.pos += 4;
      const code = Number.parseInt(hex, 16);
      if (code >= 0xd800 && code <= 0xdfff) refuse();
      return code;
    }
    // Backreferences, \p{..}, \cX, \A, \z, \Q..\E and the rest.
    return refuse();
  }

  private parseGroup(): Node {
    this.pos++; // (
    let capturing = true;
    let open = "(";
    if (this.peek() === "?") {
      const rest = this.pattern.slice(this.pos);
      if (rest.startsWith("?:")) {
        capturing = false;
        open = "(?:";
        this.pos += 2;
      } else {
        const named = /^\?<([A-Za-z_][A-Za-z0-9_]*)>/.exec(rest);
        // Lookaround, inline flags and other group kinds.
        if (named === null) refuse();
        if (this.names.has(named[1])) refuse();
        this.names.add(named[1]);
        open = `(?<${named[1]}>`;
        this.pos += named[0].length;
      }
    }
    if (capturing) this.groupCount++;
    const body = this.parseAlternation();
    if (this.peek() !== ")") refuse();
    this.pos++;
    return { type: "group", capturing, open, body };
  }

  private parseClass(): Node {
    this.pos++; // [
    let negated = false;
    if (this.peek() === "^") {
      negated = true;
      this.pos++;
    }
    // `[]` and `[^]` mean different things to the two engines.
    if (this.peek() === "]") refuse();
    const ranges: Array<[number, number]> = [];
    while (true) {
      if (this.pos >= this.pattern.length) refuse();
      if (this.peek() === "]") {
        this.pos++;
        break;
      }
      const start = this.parseClassMember();
      if (typeof start !== "number") {
        ranges.push(...start);
        continue;
      }
      if (this.peek() === "-" && this.pattern[this.pos + 1] !== "]") {
        if (this.pos + 1 >= this.pattern.length) refuse();
        this.pos++;
        const end = this.parseClassMember();
        if (typeof end !== "number" || end < start) refuse();
        ranges.push([start, end]);
      } else {
        ranges.push([start, start]);
      }
    }
    return this.classNode(ranges, negated);
  }

  /** One member of a class: a code point, or the ranges of \d, \w or \s. */
  private parseClassMember(): number | Array<[number, number]> {
    const c = this.peek();
    if (c === "[") {
      // POSIX classes, collating symbols and equivalence classes.
      const next = this.pattern[this.pos + 1];
      if (next === ":" || next === "." || next === "=") refuse();
    }
    if (c === "\\") {
      this.pos++;
      const escaped = this.peek();
      if (escaped === "") refuse();
      this.pos++;
      if (escaped === "d" || escaped === "w" || escaped === "s") {
        return rangesFor(escaped) as Array<[number, number]>;
      }
      // Negated shorthand classes and \b (backspace) inside a class.
      if ("DWSbB".includes(escaped)) refuse();
      if (escaped === "]" || escaped === "^") return escaped.charCodeAt(0);
      return this.parseEscapedCodePoint(escaped);
    }
    const code = this.pattern.codePointAt(this.pos) as number;
    this.pos += code > 0xffff ? 2 : 1;
    if (code >= 0xd800 && code <= 0xdfff) refuse();
    return code;
  }
}

// ----------------------------------------------------------------------------
// Emission
// ----------------------------------------------------------------------------

function emit(node: Node): string {
  switch (node.type) {
    case "char":
    case "assertion":
      return node.source;
    case "concat":
      return node.items.map(emit).join("");
    case "alternation":
      return node.items.map(emit).join("|");
    case "group":
      return `${node.open}${emit(node.body)})`;
    case "repeat": {
      let quantifier: string;
      if (node.min === 0 && node.max === Number.POSITIVE_INFINITY) {
        quantifier = "*";
      } else if (node.min === 1 && node.max === Number.POSITIVE_INFINITY) {
        quantifier = "+";
      } else if (node.min === 0 && node.max === 1) {
        quantifier = "?";
      } else if (node.max === Number.POSITIVE_INFINITY) {
        quantifier = `{${node.min},}`;
      } else if (node.min === node.max) {
        quantifier = `{${node.min}}`;
      } else {
        quantifier = `{${node.min},${node.max}}`;
      }
      const body = emit(node.body);
      // A repeated concatenation or alternation needs its own group.
      const wrapped =
        node.body.type === "concat" || node.body.type === "alternation"
          ? `(?:${body})`
          : body;
      return `${wrapped}${quantifier}${node.lazy ? "?" : ""}`;
    }
  }
}

// ----------------------------------------------------------------------------
// Backtracking cost
// ----------------------------------------------------------------------------

interface Cost {
  /** Unbounded repetitions that can trade characters with what follows. */
  ambiguous: number;
  /** Unbounded repetitions that cannot. */
  deterministic: number;
  /** Constant factor from optional parts and overlapping alternatives. */
  factor: number;
}

/**
 * Walk the tree, refusing shapes whose backtracking is not polynomial and
 * counting the rest. `follow` is the set of characters that can come right
 * after `node`.
 */
function assess(node: Node, follow: CharSet, cost: Cost): void {
  switch (node.type) {
    case "char":
    case "assertion":
      return;
    case "group":
      assess(node.body, follow, cost);
      return;
    case "concat": {
      // What can follow item i: the start of the items after it, through
      // every one that can match nothing, then `follow` itself.
      let after = follow;
      const follows: CharSet[] = new Array(node.items.length);
      for (let i = node.items.length - 1; i >= 0; i--) {
        follows[i] = after;
        const item = node.items[i];
        after = isNullable(item)
          ? union(firstSet(item), after)
          : firstSet(item);
      }
      for (let i = 0; i < node.items.length; i++) {
        assess(node.items[i], follows[i], cost);
      }
      return;
    }
    case "alternation": {
      const firsts = node.items.map(firstSet);
      let overlapping = false;
      for (let i = 0; i < firsts.length && !overlapping; i++) {
        for (let j = i + 1; j < firsts.length; j++) {
          if (overlaps(firsts[i], firsts[j])) {
            overlapping = true;
            break;
          }
        }
      }
      if (overlapping || node.items.some(isNullable)) {
        cost.factor *= node.items.length;
      }
      for (const item of node.items) {
        assess(item, follow, cost);
      }
      return;
    }
    case "repeat": {
      const body = node.body;
      // JavaScript drops a capture when the group matches nothing; RE2 does not.
      if (isNullable(body)) refuse();
      if (node.max <= 1) {
        // Optional. Taking or skipping it is a choice whenever what follows
        // could match the same character.
        if (overlaps(firstSet(body), follow)) cost.factor *= 2;
        assess(body, follow, cost);
        return;
      }
      // A real loop. Its body must match in exactly one way: no repetition
      // inside it, and alternatives told apart by their first character.
      if (containsRepeat(body)) refuse();
      if (!alternationsAreDecidable(body)) refuse();
      // JavaScript resets captures on each iteration; RE2 keeps the last.
      if (containsCapture(body)) refuse();
      const tradesWithFollow = overlaps(firstSet(body), follow);
      if (node.max > BOUNDED_REPEAT_LIMIT) {
        if (tradesWithFollow) cost.ambiguous++;
        else cost.deterministic++;
      } else if (tradesWithFollow) {
        cost.factor *= node.max - node.min + 1;
      }
      return;
    }
  }
}

/** Whether every match must start at the beginning of the input. */
function isAnchoredAtStart(node: Node): boolean {
  switch (node.type) {
    case "assertion":
      return node.source === "^";
    case "concat":
      return node.items.length > 0 && isAnchoredAtStart(node.items[0]);
    case "alternation":
      return node.items.every(isAnchoredAtStart);
    case "group":
      return isAnchoredAtStart(node.body);
    default:
      return false;
  }
}

/**
 * A plan for running `pattern` on the native engine, or null when it must
 * stay on RE2. `flags` are the JavaScript-style flags given to UserRegex.
 */
export function planNative(pattern: string, flags: string): NativePlan | null {
  const ignoreCase = flags.includes("i");
  try {
    const parser = new Parser(
      pattern,
      ignoreCase,
      flags.includes("m"),
      flags.includes("s"),
    );
    const tree = parser.parse();
    const cost: Cost = { ambiguous: 0, deterministic: 0, factor: 1 };
    assess(tree, emptySet(), cost);
    if (cost.factor > MAX_CHOICE_FACTOR) return null;

    // One attempt costs about n^ambiguous, times n more when a repetition
    // that cannot give characters back still has to be re-scanned. A search
    // that is not anchored makes an attempt at each of n positions.
    const loops = cost.ambiguous + cost.deterministic;
    const exponent =
      cost.ambiguous +
      (cost.deterministic > 0 ? 1 : 0) +
      (loops > 0 && !isAnchoredAtStart(tree) ? 1 : 0);
    const maxInputLength =
      exponent === 0
        ? Number.POSITIVE_INFINITY
        : Math.floor((STEP_BUDGET / cost.factor) ** (1 / exponent));
    if (maxInputLength < 16) return null;

    const source = emit(tree);
    const nativeFlags = `gu${ignoreCase ? "i" : ""}`;
    // The emitted pattern should always compile; if not, stay on RE2.
    new RegExp(source, nativeFlags);
    return {
      source,
      flags: nativeFlags,
      maxInputLength,
      groupCount: parser.groupCount,
    };
  } catch (error) {
    if (error instanceof Refused || error instanceof SyntaxError) return null;
    throw error;
  }
}
