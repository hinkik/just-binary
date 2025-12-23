import { Command, CommandContext, ExecResult } from '../../types.js';
import { hasHelpFlag, showHelp } from '../help.js';

const findHelp = {
  name: 'find',
  summary: 'search for files in a directory hierarchy',
  usage: 'find [path...] [expression]',
  options: [
    '-name PATTERN    file name matches shell pattern PATTERN',
    '-iname PATTERN   like -name but case insensitive',
    '-path PATTERN    file path matches shell pattern PATTERN',
    '-ipath PATTERN   like -path but case insensitive',
    '-type TYPE       file is of type: f (regular file), d (directory)',
    '-empty           file is empty or directory is empty',
    '-maxdepth LEVELS descend at most LEVELS directories',
    '-mindepth LEVELS do not apply tests at levels less than LEVELS',
    '-not, !          negate the following expression',
    '-a, -and         logical AND (default)',
    '-o, -or          logical OR',
    '    --help       display this help and exit',
  ],
};

function matchGlob(name: string, pattern: string, ignoreCase = false): boolean {
  // Convert glob pattern to regex
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      regex += '.*';
    } else if (c === '?') {
      regex += '.';
    } else if (c === '[') {
      // Character class
      let j = i + 1;
      while (j < pattern.length && pattern[j] !== ']') j++;
      regex += pattern.slice(i, j + 1);
      i = j;
    } else if (/[.+^${}()|\\]/.test(c)) {
      regex += '\\' + c;
    } else {
      regex += c;
    }
  }
  regex += '$';
  return new RegExp(regex, ignoreCase ? 'i' : '').test(name);
}

// Expression types for find
type Expression =
  | { type: 'name'; pattern: string; ignoreCase?: boolean }
  | { type: 'path'; pattern: string; ignoreCase?: boolean }
  | { type: 'type'; fileType: 'f' | 'd' }
  | { type: 'empty' }
  | { type: 'not'; expr: Expression }
  | { type: 'and'; left: Expression; right: Expression }
  | { type: 'or'; left: Expression; right: Expression };

// Known predicates that take arguments
const PREDICATES_WITH_ARGS = new Set(['-name', '-iname', '-path', '-ipath', '-type', '-maxdepth', '-mindepth']);
// Known predicates that don't take arguments
const PREDICATES_NO_ARGS = new Set(['-empty', '-not', '!', '-a', '-and', '-o', '-or']);

function parseExpressions(args: string[], startIndex: number): { expr: Expression | null; pathIndex: number; error?: string } {
  // Parse into tokens: expressions, operators, and negations
  type Token = { type: 'expr'; expr: Expression } | { type: 'op'; op: 'and' | 'or' } | { type: 'not' };
  const tokens: Token[] = [];
  let i = startIndex;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '-name' && i + 1 < args.length) {
      tokens.push({ type: 'expr', expr: { type: 'name', pattern: args[++i] } });
    } else if (arg === '-iname' && i + 1 < args.length) {
      tokens.push({ type: 'expr', expr: { type: 'name', pattern: args[++i], ignoreCase: true } });
    } else if (arg === '-path' && i + 1 < args.length) {
      tokens.push({ type: 'expr', expr: { type: 'path', pattern: args[++i] } });
    } else if (arg === '-ipath' && i + 1 < args.length) {
      tokens.push({ type: 'expr', expr: { type: 'path', pattern: args[++i], ignoreCase: true } });
    } else if (arg === '-type' && i + 1 < args.length) {
      const fileType = args[++i];
      if (fileType === 'f' || fileType === 'd') {
        tokens.push({ type: 'expr', expr: { type: 'type', fileType } });
      } else {
        return { expr: null, pathIndex: i, error: `find: Unknown argument to -type: ${fileType}\n` };
      }
    } else if (arg === '-empty') {
      tokens.push({ type: 'expr', expr: { type: 'empty' } });
    } else if (arg === '-not' || arg === '!') {
      tokens.push({ type: 'not' });
    } else if (arg === '-o' || arg === '-or') {
      tokens.push({ type: 'op', op: 'or' });
    } else if (arg === '-a' || arg === '-and') {
      tokens.push({ type: 'op', op: 'and' });
    } else if (arg === '-maxdepth' || arg === '-mindepth') {
      // These are handled separately, skip them
      i++;
    } else if (arg.startsWith('-')) {
      // Unknown predicate
      return { expr: null, pathIndex: i, error: `find: unknown predicate '${arg}'\n` };
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
    return { expr: null, pathIndex: i };
  }

  // Process NOT operators - they bind to the immediately following expression
  const processedTokens: (Token & { type: 'expr' | 'op' })[] = [];
  for (let j = 0; j < tokens.length; j++) {
    const token = tokens[j];
    if (token.type === 'not') {
      // Find the next expression and negate it
      if (j + 1 < tokens.length && tokens[j + 1].type === 'expr') {
        const nextExpr = (tokens[j + 1] as { type: 'expr'; expr: Expression }).expr;
        processedTokens.push({ type: 'expr', expr: { type: 'not', expr: nextExpr } });
        j++; // Skip the next token since we consumed it
      }
    } else if (token.type === 'expr' || token.type === 'op') {
      processedTokens.push(token as Token & { type: 'expr' | 'op' });
    }
  }

  // Build expression tree with proper precedence:
  // 1. Implicit AND (adjacent expressions) has highest precedence
  // 2. Explicit -a has same as implicit AND
  // 3. -o has lowest precedence

  // First pass: group by OR, collecting AND groups
  const orGroups: Expression[][] = [[]];

  for (const token of processedTokens) {
    if (token.type === 'op' && token.op === 'or') {
      orGroups.push([]);
    } else if (token.type === 'expr') {
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
      result = { type: 'and', left: result, right: group[j] };
    }
    andResults.push(result);
  }

  if (andResults.length === 0) {
    return { expr: null, pathIndex: i };
  }

  // Combine AND results with OR
  let result = andResults[0];
  for (let j = 1; j < andResults.length; j++) {
    result = { type: 'or', left: result, right: andResults[j] };
  }

  return { expr: result, pathIndex: i };
}

interface EvalContext {
  name: string;
  relativePath: string;
  isFile: boolean;
  isDirectory: boolean;
  isEmpty: boolean;
}

function evaluateExpression(expr: Expression, ctx: EvalContext): boolean {
  switch (expr.type) {
    case 'name':
      return matchGlob(ctx.name, expr.pattern, expr.ignoreCase);
    case 'path':
      return matchGlob(ctx.relativePath, expr.pattern, expr.ignoreCase);
    case 'type':
      if (expr.fileType === 'f') return ctx.isFile;
      if (expr.fileType === 'd') return ctx.isDirectory;
      return false;
    case 'empty':
      return ctx.isEmpty;
    case 'not':
      return !evaluateExpression(expr.expr, ctx);
    case 'and':
      return evaluateExpression(expr.left, ctx) &&
             evaluateExpression(expr.right, ctx);
    case 'or':
      return evaluateExpression(expr.left, ctx) ||
             evaluateExpression(expr.right, ctx);
  }
}

export const findCommand: Command = {
  name: 'find',
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(findHelp);
    }

    let searchPath = '.';
    let maxDepth: number | null = null;
    let minDepth: number | null = null;

    // Find the path argument and parse -maxdepth/-mindepth
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-maxdepth' && i + 1 < args.length) {
        maxDepth = parseInt(args[++i], 10);
      } else if (arg === '-mindepth' && i + 1 < args.length) {
        minDepth = parseInt(args[++i], 10);
      } else if (!arg.startsWith('-')) {
        searchPath = arg;
      } else if (PREDICATES_WITH_ARGS.has(arg)) {
        // Skip value arguments for predicates that take arguments
        i++;
      }
    }

    // Parse expressions
    const { expr, error } = parseExpressions(args, 0);

    // Return error for unknown predicates
    if (error) {
      return { stdout: '', stderr: error, exitCode: 1 };
    }

    const basePath = ctx.fs.resolvePath(ctx.cwd, searchPath);

    // Check if path exists
    try {
      await ctx.fs.stat(basePath);
    } catch {
      return {
        stdout: '',
        stderr: `find: ${searchPath}: No such file or directory\n`,
        exitCode: 1,
      };
    }

    const results: string[] = [];

    // Recursive function to find files
    async function findRecursive(currentPath: string, depth: number): Promise<void> {
      // Check maxdepth - don't descend beyond this depth
      if (maxDepth !== null && depth > maxDepth) {
        return;
      }

      let stat;
      try {
        stat = await ctx.fs.stat(currentPath);
      } catch {
        return;
      }

      // For the starting directory, use the search path itself as the name
      // (e.g., when searching from '.', the name should be '.')
      let name: string;
      if (currentPath === basePath) {
        name = searchPath.split('/').pop() || searchPath;
      } else {
        name = currentPath.split('/').pop() || '';
      }

      const relativePath =
        currentPath === basePath
          ? searchPath
          : searchPath === '.'
            ? './' + currentPath.slice(basePath.length + 1)
            : searchPath + currentPath.slice(basePath.length);

      // Determine if entry is empty
      let isEmpty = false;
      if (stat.isFile) {
        // File is empty if size is 0
        isEmpty = stat.size === 0;
      } else if (stat.isDirectory) {
        // Directory is empty if it has no entries
        const entries = await ctx.fs.readdir(currentPath);
        isEmpty = entries.length === 0;
      }

      // Check if this entry matches our criteria
      // Only apply tests if we're at or beyond mindepth
      const atOrBeyondMinDepth = minDepth === null || depth >= minDepth;
      let matches = atOrBeyondMinDepth;

      if (matches && expr !== null) {
        const evalCtx: EvalContext = {
          name,
          relativePath,
          isFile: stat.isFile,
          isDirectory: stat.isDirectory,
          isEmpty,
        };
        matches = evaluateExpression(expr, evalCtx);
      }

      if (matches) {
        results.push(relativePath);
      }

      // Recurse into directories
      if (stat.isDirectory) {
        const entries = await ctx.fs.readdir(currentPath);
        for (const entry of entries) {
          const childPath = currentPath === '/' ? '/' + entry : currentPath + '/' + entry;
          await findRecursive(childPath, depth + 1);
        }
      }
    }

    await findRecursive(basePath, 0);

    // Don't sort - real find uses filesystem traversal order
    const output = results.length > 0 ? results.join('\n') + '\n' : '';
    return { stdout: output, stderr: '', exitCode: 0 };
  },
};
