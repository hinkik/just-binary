import { Command, CommandContext, ExecResult } from '../../types.js';

function matchGlob(name: string, pattern: string): boolean {
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
  return new RegExp(regex).test(name);
}

// Expression types for find
type Expression =
  | { type: 'name'; pattern: string }
  | { type: 'type'; fileType: 'f' | 'd' }
  | { type: 'and'; left: Expression; right: Expression }
  | { type: 'or'; left: Expression; right: Expression };

function parseExpressions(args: string[], startIndex: number): { expr: Expression | null; pathIndex: number } {
  // Parse into tokens: expressions and operators
  type Token = { type: 'expr'; expr: Expression } | { type: 'op'; op: 'and' | 'or' };
  const tokens: Token[] = [];
  let i = startIndex;

  while (i < args.length) {
    const arg = args[i];

    if (arg === '-name' && i + 1 < args.length) {
      tokens.push({ type: 'expr', expr: { type: 'name', pattern: args[++i] } });
    } else if (arg === '-type' && i + 1 < args.length) {
      const fileType = args[++i];
      if (fileType === 'f' || fileType === 'd') {
        tokens.push({ type: 'expr', expr: { type: 'type', fileType } });
      }
    } else if (arg === '-o' || arg === '-or') {
      tokens.push({ type: 'op', op: 'or' });
    } else if (arg === '-a' || arg === '-and') {
      tokens.push({ type: 'op', op: 'and' });
    } else if (!arg.startsWith('-')) {
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

  // Build expression tree with proper precedence:
  // 1. Implicit AND (adjacent expressions) has highest precedence
  // 2. Explicit -a has same as implicit AND
  // 3. -o has lowest precedence

  // First pass: group by OR, collecting AND groups
  const orGroups: Expression[][] = [[]];

  for (const token of tokens) {
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

function evaluateExpression(expr: Expression, name: string, isFile: boolean, isDirectory: boolean): boolean {
  switch (expr.type) {
    case 'name':
      return matchGlob(name, expr.pattern);
    case 'type':
      if (expr.fileType === 'f') return isFile;
      if (expr.fileType === 'd') return isDirectory;
      return false;
    case 'and':
      return evaluateExpression(expr.left, name, isFile, isDirectory) &&
             evaluateExpression(expr.right, name, isFile, isDirectory);
    case 'or':
      return evaluateExpression(expr.left, name, isFile, isDirectory) ||
             evaluateExpression(expr.right, name, isFile, isDirectory);
  }
}

export const findCommand: Command = {
  name: 'find',
  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    let searchPath = '.';

    // Find the path argument (first non-flag argument)
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!arg.startsWith('-')) {
        searchPath = arg;
        break;
      }
      // Skip value arguments
      if (arg === '-name' || arg === '-type') {
        i++;
      }
    }

    // Parse expressions
    const { expr } = parseExpressions(args, 0);

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
    async function findRecursive(currentPath: string): Promise<void> {
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

      // Check if this entry matches our criteria
      let matches = true;

      if (expr !== null) {
        matches = evaluateExpression(expr, name, stat.isFile, stat.isDirectory);
      }

      if (matches) {
        results.push(relativePath);
      }

      // Recurse into directories
      if (stat.isDirectory) {
        const entries = await ctx.fs.readdir(currentPath);
        for (const entry of entries) {
          const childPath = currentPath === '/' ? '/' + entry : currentPath + '/' + entry;
          await findRecursive(childPath);
        }
      }
    }

    await findRecursive(basePath);

    // Don't sort - real find uses filesystem traversal order
    const output = results.length > 0 ? results.join('\n') + '\n' : '';
    return { stdout: output, stderr: '', exitCode: 0 };
  },
};
