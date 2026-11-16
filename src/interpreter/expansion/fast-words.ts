/**
 * Synchronous expansion of the commonest word shapes.
 *
 * Most words in a script are literals (`echo`, `-lt`, `'text'`), quoted
 * strings with plain variables (`"$dir/$name"`), a bare variable (`$i`), or a
 * sole arithmetic expansion (`$((i + 1))`). The general expansion machinery
 * handles every bash feature and suspends at each step; for these shapes
 * nothing needs to suspend. The functions here expand such words directly and
 * return undefined for anything else — the caller then uses the general path,
 * which remains the definition of what a word expands to.
 *
 * Setting JUST_BASH_VERIFY_FAST_PATHS=1 makes every caller run both paths
 * and throw when they disagree.
 */

import type { WordNode, WordPart } from "../../ast/types.js";
import { EnvMap, encode } from "../../utils/bytes.js";
import {
  evaluateArithmeticExpansionSync,
  fastPathsAreSuppressed,
  withFastPathsSuppressed,
} from "../arithmetic.js";
import { getIfs } from "../helpers/ifs.js";
import { isNameref } from "../helpers/nameref.js";
import type { InterpreterContext } from "../types.js";
import { hasGlobPattern } from "./glob-escape.js";
import { getVariableSync } from "./variable.js";

export const VERIFY_FAST_PATHS: boolean =
  typeof process !== "undefined" &&
  process.env?.JUST_BASH_VERIFY_FAST_PATHS === "1";

/** One step of a word plan. */
type Step =
  | { kind: "text"; text: string }
  | { kind: "variable"; name: string; quoted: boolean }
  | {
      kind: "arithmetic";
      part: WordPart & { type: "ArithmeticExpansion" };
      quoted: boolean;
    };

interface WordPlan {
  steps: Step[];
  /** The whole word when it is constant, with its bytes. */
  constantText: string | undefined;
  constantBytes: Uint8Array | undefined;
  /** No expansion sits outside quotes: no word splitting or globbing. */
  fullyQuotedExpansions: boolean;
  /** The literal text alone could be taken for a glob pattern. */
  literalLooksLikeGlob: boolean;
}

const plans = new WeakMap<WordNode, WordPlan | null>();

/** Names whose value changes between two reads or that produce many words. */
const UNSUPPORTED_NAME = /^(?:[@*]|RANDOM|SECONDS)$/;
const SIMPLE_NAME = /^(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]+|[?#$!\-_])$/;

function planFor(word: WordNode): WordPlan | null {
  let plan = plans.get(word);
  if (plan === undefined) {
    plan = buildPlan(word);
    plans.set(word, plan);
  }
  return plan;
}

function buildPlan(word: WordNode): WordPlan | null {
  const steps: Step[] = [];
  let fullyQuotedExpansions = true;
  let expansions = 0;
  let arithmetic = 0;

  const pushText = (text: string) => {
    const last = steps[steps.length - 1];
    if (last?.kind === "text") {
      last.text += text;
    } else {
      steps.push({ kind: "text", text });
    }
  };

  const addPart = (part: WordPart, quoted: boolean): boolean => {
    switch (part.type) {
      case "Literal":
      case "SingleQuoted":
      case "Escaped":
        pushText(part.value);
        return true;
      case "ParameterExpansion":
        if (
          part.operation ||
          !SIMPLE_NAME.test(part.parameter) ||
          UNSUPPORTED_NAME.test(part.parameter)
        ) {
          return false;
        }
        steps.push({ kind: "variable", name: part.parameter, quoted });
        expansions++;
        if (!quoted) fullyQuotedExpansions = false;
        return true;
      case "ArithmeticExpansion":
        steps.push({ kind: "arithmetic", part, quoted });
        expansions++;
        arithmetic++;
        if (!quoted) fullyQuotedExpansions = false;
        return true;
      case "DoubleQuoted":
        if (quoted) return false;
        for (const inner of part.parts) {
          // A single-quoted part cannot occur inside double quotes; anything
          // else unusual goes to the general path.
          if (inner.type === "SingleQuoted" || inner.type === "DoubleQuoted") {
            return false;
          }
          if (!addPart(inner, true)) return false;
        }
        return true;
      default:
        return false;
    }
  };

  for (const part of word.parts) {
    if (!addPart(part, false)) return null;
  }
  // Arithmetic can assign. Evaluating it and then giving up on a later step
  // would run it twice, so it must be the word's only expansion.
  if (arithmetic > 0 && expansions > 1) return null;

  if (expansions === 0) {
    const text = steps.length === 0 ? "" : (steps[0] as { text: string }).text;
    return {
      steps,
      constantText: text,
      constantBytes: encode(text),
      fullyQuotedExpansions: true,
      literalLooksLikeGlob: false,
    };
  }
  let literal = "";
  for (const step of steps) {
    if (step.kind === "text") literal += step.text;
  }
  return {
    steps,
    constantText: undefined,
    constantBytes: undefined,
    fullyQuotedExpansions,
    literalLooksLikeGlob: looksLikeGlob(literal),
  };
}

function looksLikeGlob(text: string): boolean {
  return text.includes("\\") || hasGlobPattern(text, false);
}

function readVariable(
  ctx: InterpreterContext,
  name: string,
): string | undefined {
  const env = ctx.state.env;
  if (!(env instanceof EnvMap)) return undefined;
  if (isNameref(ctx, name)) return undefined;
  // A value holding bytes that are not valid UTF-8 has no faithful text.
  if (env.getExactText(name) === null) return undefined;
  return getVariableSync(ctx, name);
}

function runPlan(ctx: InterpreterContext, plan: WordPlan): string | undefined {
  const steps = plan.steps;
  let out = "";
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind === "text") {
      out += step.text;
    } else if (step.kind === "variable") {
      const value = readVariable(ctx, step.name);
      if (value === undefined) return undefined;
      out += value;
    } else {
      const value = evaluateArithmeticExpansionSync(ctx, step.part.expression);
      if (value === undefined) return undefined;
      out += String(value);
    }
  }
  return out;
}

/**
 * The text a word expands to where no word splitting or globbing applies:
 * a command name, an assignment value, a here-string. Matches expandWord.
 */
export function expandWordTextSync(
  ctx: InterpreterContext,
  word: WordNode,
): string | undefined {
  if (fastPathsAreSuppressed()) return undefined;
  const plan = planFor(word);
  if (plan === null) return undefined;
  if (plan.constantText !== undefined) return plan.constantText;
  return runPlan(ctx, plan);
}

export interface FastArgument {
  bytes: Uint8Array;
  /** As reported by the general path: true when taken as bytes verbatim. */
  quoted: boolean;
}

/**
 * A command argument that expands to exactly one word. Returns undefined
 * when the word may split, glob, vanish, or needs the general path.
 */
export function expandArgumentSync(
  ctx: InterpreterContext,
  word: WordNode,
): FastArgument | undefined {
  if (fastPathsAreSuppressed()) return undefined;
  const plan = planFor(word);
  if (plan === null) return undefined;
  if (plan.constantBytes !== undefined) {
    return { bytes: plan.constantBytes, quoted: true };
  }
  if (plan.fullyQuotedExpansions) {
    // Arithmetic inside quotes is not on the general path's verbatim-bytes
    // route; leave its `quoted` flag to that path.
    for (const step of plan.steps) {
      if (step.kind === "arithmetic") return undefined;
    }
    const text = runPlan(ctx, plan);
    if (text === undefined) return undefined;
    return { bytes: encode(text), quoted: true };
  }

  // An unquoted expansion: its value is split on IFS and then globbed. Take
  // the word only when neither can change it.
  if (ctx.state.shoptOptions.extglob || plan.literalLooksLikeGlob) {
    return undefined;
  }
  const ifs = getIfs(ctx.state.env);
  if (ifs === "") return undefined;
  const steps = plan.steps;
  let out = "";
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.kind === "text") {
      out += step.text;
      continue;
    }
    if (step.kind === "arithmetic") {
      // The result is a decimal integer. Decide whether IFS could split it
      // before evaluating: giving up afterwards would evaluate it twice.
      if (!step.quoted && /[0-9-]/.test(ifs)) return undefined;
      const number = evaluateArithmeticExpansionSync(ctx, step.part.expression);
      if (number === undefined) return undefined;
      out += String(number);
      continue;
    }
    const value = readVariable(ctx, step.name);
    if (value === undefined) return undefined;
    if (!step.quoted) {
      if (value === "") return undefined;
      for (let j = 0; j < value.length; j++) {
        if (ifs.includes(value[j])) return undefined;
      }
    }
    out += value;
  }
  if (looksLikeGlob(out)) return undefined;
  return { bytes: encode(out), quoted: false };
}

// ============================================================================
// Verification
// ============================================================================

function sameEnv(a: EnvMap, b: EnvMap): boolean {
  if (a.size !== b.size) return false;
  for (const key of a.keys()) {
    const left = a.get(key) as Uint8Array;
    const right = b.get(key);
    if (right === undefined || left.length !== right.length) return false;
    for (let i = 0; i < left.length; i++) {
      if (left[i] !== right[i]) return false;
    }
  }
  return true;
}

/**
 * Run a fast path and the general path it stands in for, and throw unless
 * they agree on the result and on every variable. Only called when
 * VERIFY_FAST_PATHS is set. The general path's effects are the ones kept.
 */
export async function verifyFastPath<T>(
  ctx: InterpreterContext,
  what: string,
  fast: () => T | undefined,
  general: () => Promise<T>,
  same: (fast: T, general: T) => boolean,
): Promise<T | undefined> {
  const env = ctx.state.env;
  if (!(env instanceof EnvMap)) return fast();
  const before = env.clone();
  const fastResult = fast();
  if (fastResult === undefined) {
    if (!sameEnv(env, before)) {
      throw new Error(`fast path gave up after changing variables: ${what}`);
    }
    return undefined;
  }
  const afterFast = env.clone();
  env.restoreFrom(before);
  const generalResult = await withFastPathsSuppressed(general);
  if (!same(fastResult, generalResult)) {
    throw new Error(
      `fast path result differs: ${what}: ${JSON.stringify(fastResult)} vs ${JSON.stringify(generalResult)}`,
    );
  }
  if (!sameEnv(env, afterFast)) {
    throw new Error(`fast path left different variables: ${what}`);
  }
  return fastResult;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
