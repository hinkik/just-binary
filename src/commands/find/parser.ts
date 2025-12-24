// Parser for find expressions

import type { Expression, FindAction, ParseResult, SizeUnit } from "./types.js";

// Token types for parsing
type Token =
  | { type: "expr"; expr: Expression }
  | { type: "op"; op: "and" | "or" }
  | { type: "not" };

export function parseExpressions(
  args: string[],
  startIndex: number,
): ParseResult {
  // Parse into tokens: expressions, operators, and negations
  const tokens: Token[] = [];
  const actions: FindAction[] = [];
  let i = startIndex;

  while (i < args.length) {
    const arg = args[i];

    if (arg === "-name" && i + 1 < args.length) {
      tokens.push({ type: "expr", expr: { type: "name", pattern: args[++i] } });
    } else if (arg === "-iname" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "name", pattern: args[++i], ignoreCase: true },
      });
    } else if (arg === "-path" && i + 1 < args.length) {
      tokens.push({ type: "expr", expr: { type: "path", pattern: args[++i] } });
    } else if (arg === "-ipath" && i + 1 < args.length) {
      tokens.push({
        type: "expr",
        expr: { type: "path", pattern: args[++i], ignoreCase: true },
      });
    } else if (arg === "-type" && i + 1 < args.length) {
      const fileType = args[++i];
      if (fileType === "f" || fileType === "d") {
        tokens.push({ type: "expr", expr: { type: "type", fileType } });
      } else {
        return {
          expr: null,
          pathIndex: i,
          error: `find: Unknown argument to -type: ${fileType}\n`,
          actions: [],
        };
      }
    } else if (arg === "-empty") {
      tokens.push({ type: "expr", expr: { type: "empty" } });
    } else if (arg === "-mtime" && i + 1 < args.length) {
      const mtimeArg = args[++i];
      let comparison: "exact" | "more" | "less" = "exact";
      let daysStr = mtimeArg;
      if (mtimeArg.startsWith("+")) {
        comparison = "more";
        daysStr = mtimeArg.slice(1);
      } else if (mtimeArg.startsWith("-")) {
        comparison = "less";
        daysStr = mtimeArg.slice(1);
      }
      const days = parseInt(daysStr, 10);
      if (!Number.isNaN(days)) {
        tokens.push({
          type: "expr",
          expr: { type: "mtime", days, comparison },
        });
      }
    } else if (arg === "-newer" && i + 1 < args.length) {
      const refPath = args[++i];
      tokens.push({ type: "expr", expr: { type: "newer", refPath } });
    } else if (arg === "-size" && i + 1 < args.length) {
      const sizeArg = args[++i];
      let comparison: "exact" | "more" | "less" = "exact";
      let sizeStr = sizeArg;
      if (sizeArg.startsWith("+")) {
        comparison = "more";
        sizeStr = sizeArg.slice(1);
      } else if (sizeArg.startsWith("-")) {
        comparison = "less";
        sizeStr = sizeArg.slice(1);
      }
      // Parse size with optional suffix (c=bytes, k=KB, M=MB, G=GB, default=512-byte blocks)
      const sizeMatch = sizeStr.match(/^(\d+)([ckMGb])?$/);
      if (sizeMatch) {
        const value = parseInt(sizeMatch[1], 10);
        const unit = (sizeMatch[2] || "b") as SizeUnit;
        tokens.push({
          type: "expr",
          expr: { type: "size", value, unit, comparison },
        });
      }
    } else if (arg === "-perm" && i + 1 < args.length) {
      const permArg = args[++i];
      // Parse permission mode: octal, -mode (all bits), /mode (any bit)
      let matchType: "exact" | "all" | "any" = "exact";
      let modeStr = permArg;
      if (permArg.startsWith("-")) {
        matchType = "all";
        modeStr = permArg.slice(1);
      } else if (permArg.startsWith("/")) {
        matchType = "any";
        modeStr = permArg.slice(1);
      }
      // Parse as octal
      const mode = parseInt(modeStr, 8);
      if (!Number.isNaN(mode)) {
        tokens.push({
          type: "expr",
          expr: { type: "perm", mode, matchType },
        });
      }
    } else if (arg === "-not" || arg === "!") {
      tokens.push({ type: "not" });
    } else if (arg === "-o" || arg === "-or") {
      tokens.push({ type: "op", op: "or" });
    } else if (arg === "-a" || arg === "-and") {
      tokens.push({ type: "op", op: "and" });
    } else if (arg === "-maxdepth" || arg === "-mindepth") {
      // These are handled separately, skip them
      i++;
    } else if (arg === "-exec") {
      // Parse -exec command {} ; or -exec command {} +
      const commandParts: string[] = [];
      i++;
      while (i < args.length && args[i] !== ";" && args[i] !== "+") {
        commandParts.push(args[i]);
        i++;
      }
      if (i >= args.length) {
        return {
          expr: null,
          pathIndex: i,
          error: "find: missing argument to `-exec'\n",
          actions: [],
        };
      }
      const batchMode = args[i] === "+";
      actions.push({ type: "exec", command: commandParts, batchMode });
    } else if (arg === "-print") {
      actions.push({ type: "print" });
    } else if (arg === "-print0") {
      actions.push({ type: "print0" });
    } else if (arg === "-delete") {
      actions.push({ type: "delete" });
    } else if (arg.startsWith("-")) {
      // Unknown predicate
      return {
        expr: null,
        pathIndex: i,
        error: `find: unknown predicate '${arg}'\n`,
        actions: [],
      };
    } else {
      // This is the path - skip if at start, otherwise stop
      if (tokens.length === 0) {
        i++;
        continue;
      }
      break;
    }
    i++;
  }

  if (tokens.length === 0) {
    return { expr: null, pathIndex: i, actions };
  }

  // Process NOT operators - they bind to the immediately following expression
  const processedTokens: (Token & { type: "expr" | "op" })[] = [];
  for (let j = 0; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.type === "not") {
      // Find the next expression and negate it
      if (j + 1 < tokens.length && tokens[j + 1].type === "expr") {
        const nextExpr = (tokens[j + 1] as { type: "expr"; expr: Expression })
          .expr;
        processedTokens.push({
          type: "expr",
          expr: { type: "not", expr: nextExpr },
        });
        j++; // Skip the next token since we consumed it
      }
    } else if (token.type === "expr" || token.type === "op") {
      processedTokens.push(token as Token & { type: "expr" | "op" });
    }
  }

  // Build expression tree with proper precedence:
  // 1. Implicit AND (adjacent expressions) has highest precedence
  // 2. Explicit -a has same as implicit AND
  // 3. -o has lowest precedence

  // First pass: group by OR, collecting AND groups
  const orGroups: Expression[][] = [[]];

  for (const token of processedTokens) {
    if (token.type === "op" && token.op === "or") {
      orGroups.push([]);
    } else if (token.type === "expr") {
      orGroups[orGroups.length - 1].push(token.expr);
    }
    // Ignore explicit 'and' - it's same as implicit
  }

  // Combine each AND group
  const andResults: Expression[] = [];
  for (const group of orGroups) {
    if (group.length === 0) continue;
    let result = group[0];
    for (let j = 1; j < group.length; j++) {
      result = { type: "and", left: result, right: group[j] };
    }
    andResults.push(result);
  }

  if (andResults.length === 0) {
    return { expr: null, pathIndex: i, actions };
  }

  // Combine AND results with OR
  let result = andResults[0];
  for (let j = 1; j < andResults.length; j++) {
    result = { type: "or", left: result, right: andResults[j] };
  }

  return { expr: result, pathIndex: i, actions };
}
