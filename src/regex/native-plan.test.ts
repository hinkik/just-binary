import { describe, expect, it } from "vitest";
import { planNative } from "./native-plan.js";
import { createUserRegex } from "./user-regex.js";

describe("planNative", () => {
  it("refuses shapes with unbounded backtracking", () => {
    for (const pattern of [
      "(a+)+b",
      "(a*)*",
      "(a|aa)+c",
      "(\\w+\\.)+com",
      "(x+x+)+y",
      "(.*)*",
      "(a|a)+",
    ]) {
      expect({ pattern, plan: planNative(pattern, "") }).toEqual({
        pattern,
        plan: null,
      });
    }
  });

  it("refuses constructs the two engines read differently", () => {
    for (const pattern of [
      "(a)\\1",
      "(?=a)b",
      "[[:alpha:]]",
      "\\p{L}",
      "(?i)a",
      "(?:(a)|b)*",
      "(a*)?",
      "[]a]",
      "a**",
      "\\Qa\\E",
    ]) {
      expect({ pattern, plan: planNative(pattern, "") }).toEqual({
        pattern,
        plan: null,
      });
    }
    expect(planNative("\\bfoo", "i")).toBeNull();
    expect(planNative("é", "i")).toBeNull();
  });

  it("re-emits a pattern with RE2's meaning", () => {
    expect(planNative("a.c\\s\\d$", "")).toEqual({
      source: "a[^\\u{a}]c[\\u{9}-\\u{a}\\u{c}-\\u{d}\\u{20}][0-9]$",
      flags: "gu",
      maxInputLength: Number.POSITIVE_INFINITY,
      groupCount: 0,
    });
    expect(planNative("^x$", "m")?.source).toBe("(?<![^\\n])x(?![^\\n])");
  });

  it("bounds the input length by how much a pattern can backtrack", () => {
    // No repetition: any length.
    expect(planNative("user(12|45)[0-9]\\b", "")?.maxInputLength).toBe(
      Number.POSITIVE_INFINITY,
    );
    // One repetition that can trade characters, searched from every start.
    expect(planNative("foo.*bar", "")?.maxInputLength).toBe(3162);
    // Anchored, and each repetition ends where the next part begins.
    expect(planNative("^[a-z]+=[0-9]+$", "")?.maxInputLength).toBe(1e7);
    // Three repetitions over the same characters.
    expect(planNative("a*a*a*b", "")?.maxInputLength).toBe(56);
  });
});

describe("UserRegex engines agree", () => {
  // Deterministic generator, so a failure names a reproducible case.
  let seed = 12345;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const pick = <T>(items: T[]): T => items[random(items.length)];

  const atoms = [
    "a",
    "b",
    "ab",
    ".",
    "\\d",
    "\\w",
    "\\s",
    "\\S",
    "[a-c]",
    "[^b]",
    "[0-9_]",
    "\\.",
    "x",
    " ",
    "\\b",
    "é",
  ];
  const quantifiers = ["", "", "", "*", "+", "?", "{2}", "{1,3}", "*?", "+?"];
  const pattern = (depth: number): string => {
    let out = random(6) === 0 ? "^" : "";
    const parts = 1 + random(4);
    for (let i = 0; i < parts; i++) {
      if (depth > 0 && random(4) === 0) {
        const open = pick(["(", "(?:", `(?<n${depth}${i}>`]);
        out += `${open}${pattern(depth - 1)}${random(3) === 0 ? `|${pattern(depth - 1)}` : ""})${pick(quantifiers)}`;
      } else {
        out += pick(atoms) + pick(quantifiers);
      }
    }
    return out + (random(6) === 0 ? "$" : "");
  };
  const inputAlphabet = "aabbcx1 9._\n\ré😀\t";
  const input = (): string => {
    let out = "";
    const length = random(14);
    for (let i = 0; i < length; i++) {
      out +=
        Array.from(inputAlphabet)[random(Array.from(inputAlphabet).length)];
    }
    return out;
  };

  it("on generated patterns and inputs", () => {
    let nativeRuns = 0;
    for (let round = 0; round < 3000; round++) {
      const source = pattern(2);
      const flags = pick(["", "", "i", "m", "s", "g", "gi"]);
      let fast: ReturnType<typeof createUserRegex>;
      try {
        fast = createUserRegex(source, flags);
      } catch {
        continue; // RE2 rejects the pattern; nothing to compare.
      }
      if (planNative(source, flags) !== null) nativeRuns++;
      // The same regex with the native engine switched off.
      const reference = createUserRegex(source, flags);
      (reference as unknown as { _re2Only: boolean })._re2Only = true;
      for (let k = 0; k < 6; k++) {
        const text = input();
        const run = (regex: typeof fast) => {
          regex.lastIndex = 0;
          const exec = regex.exec(text);
          regex.lastIndex = 0;
          return {
            test: regex.test(text),
            exec: exec && { items: Array.from(exec), index: exec.index },
            search: regex.search(text),
            split: regex.split(text),
            replaced: regex.replace(text, "<>"),
            mapped: regex.replace(
              text,
              (m, ...rest) => `[${m}|${rest.length}]`,
            ),
            match: regex.match(text) && Array.from(regex.match(text) ?? []),
          };
        };
        expect({ source, flags, text, result: run(fast) }).toEqual({
          source,
          flags,
          text,
          result: run(reference),
        });
      }
    }
    // The comparison means nothing unless the native engine actually ran.
    expect(nativeRuns).toBeGreaterThan(500);
  });
});
