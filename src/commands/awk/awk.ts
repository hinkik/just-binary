import { Command, CommandContext, ExecResult } from '../../types.js';
import { hasHelpFlag, showHelp, unknownOption } from '../help.js';

const awkHelp = {
  name: 'awk',
  summary: 'pattern scanning and text processing language',
  usage: "awk [OPTIONS] 'PROGRAM' [FILE...]",
  options: [
    '-F FS      use FS as field separator',
    '-v VAR=VAL assign VAL to variable VAR',
    '    --help display this help and exit',
  ],
};

interface AwkContext {
  FS: string;
  OFS: string;
  NR: number;
  NF: number;
  fields: string[];
  line: string;
  vars: Record<string, string | number>;
}

export const awkCommand: Command = {
  name: 'awk',

  async execute(args: string[], ctx: CommandContext): Promise<ExecResult> {
    if (hasHelpFlag(args)) {
      return showHelp(awkHelp);
    }

    let fieldSep = /\s+/;
    let fieldSepStr = ' ';
    const vars: Record<string, string | number> = {};
    let programIdx = 0;

    // Parse options
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-F' && i + 1 < args.length) {
        fieldSepStr = processEscapes(args[++i]);
        fieldSep = new RegExp(escapeRegex(fieldSepStr));
        programIdx = i + 1;
      } else if (arg.startsWith('-F')) {
        fieldSepStr = processEscapes(arg.slice(2));
        fieldSep = new RegExp(escapeRegex(fieldSepStr));
        programIdx = i + 1;
      } else if (arg === '-v' && i + 1 < args.length) {
        const assignment = args[++i];
        const eqIdx = assignment.indexOf('=');
        if (eqIdx > 0) {
          const varName = assignment.slice(0, eqIdx);
          const varValue = assignment.slice(eqIdx + 1);
          vars[varName] = varValue;
        }
        programIdx = i + 1;
      } else if (arg.startsWith('--')) {
        return unknownOption('awk', arg);
      } else if (arg.startsWith('-') && arg.length > 1) {
        // Check for unknown short options (F and v require args)
        const optChar = arg[1];
        if (optChar !== 'F' && optChar !== 'v') {
          return unknownOption('awk', `-${optChar}`);
        }
        programIdx = i + 1;
      } else if (!arg.startsWith('-')) {
        programIdx = i;
        break;
      }
    }

    if (programIdx >= args.length) {
      return { stdout: '', stderr: 'awk: missing program\n', exitCode: 1 };
    }

    const program = args[programIdx];
    const files = args.slice(programIdx + 1);

    // Get input
    let input: string;
    if (files.length > 0) {
      const contents: string[] = [];
      for (const file of files) {
        try {
          const filePath = ctx.fs.resolvePath(ctx.cwd, file);
          contents.push(await ctx.fs.readFile(filePath));
        } catch {
          return { stdout: '', stderr: `awk: ${file}: No such file or directory\n`, exitCode: 1 };
        }
      }
      input = contents.join('');
    } else {
      input = ctx.stdin;
    }

    // Parse program
    const { begin, main, end } = parseAwkProgram(program);

    // Execute
    const awkCtx: AwkContext = {
      FS: fieldSepStr,
      OFS: ' ',
      NR: 0,
      NF: 0,
      fields: [],
      line: '',
      vars,
    };

    let stdout = '';

    // BEGIN block
    if (begin) {
      stdout += executeAwkAction(begin, awkCtx);
    }

    // Process lines
    const lines = input.split('\n');
    // Remove trailing empty line if input ends with newline
    if (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    for (const line of lines) {
      awkCtx.NR++;
      awkCtx.line = line;
      awkCtx.fields = line.split(fieldSep);
      awkCtx.NF = awkCtx.fields.length;

      for (const rule of main) {
        if (matchesPattern(rule.pattern, awkCtx)) {
          stdout += executeAwkAction(rule.action, awkCtx);
        }
      }
    }

    // END block
    if (end) {
      stdout += executeAwkAction(end, awkCtx);
    }

    return { stdout, stderr: '', exitCode: 0 };
  },
};

interface AwkRule {
  pattern: string | null;
  action: string;
}

interface ParsedProgram {
  begin: string | null;
  main: AwkRule[];
  end: string | null;
}

function parseAwkProgram(program: string): ParsedProgram {
  const result: ParsedProgram = { begin: null, main: [], end: null };

  // Simple parser for common awk patterns
  let remaining = program.trim();

  // Check for BEGIN block
  const beginMatch = remaining.match(/^BEGIN\s*\{([^}]*)\}\s*/);
  if (beginMatch) {
    result.begin = beginMatch[1].trim();
    remaining = remaining.slice(beginMatch[0].length);
  }

  // Check for END block at the end
  const endMatch = remaining.match(/\s*END\s*\{([^}]*)\}$/);
  if (endMatch) {
    result.end = endMatch[1].trim();
    remaining = remaining.slice(0, -endMatch[0].length);
  }

  remaining = remaining.trim();

  if (remaining) {
    // Parse main rules
    // Common patterns: { action }, /pattern/ { action }, condition { action }
    // Also: /pattern/ (no action, defaults to print), condition (no action, defaults to print)

    // Simple case: just { action }
    const simpleAction = remaining.match(/^\{([^}]*)\}$/);
    if (simpleAction) {
      result.main.push({ pattern: null, action: simpleAction[1].trim() });
    } else {
      // Pattern { action }
      const patternAction = remaining.match(/^\/([^/]*)\/\s*\{([^}]*)\}$/);
      if (patternAction) {
        result.main.push({ pattern: patternAction[1], action: patternAction[2].trim() });
      } else {
        // Pattern only (no action) - /pattern/ - default action is print
        const patternOnly = remaining.match(/^\/([^/]*)\/$/);
        if (patternOnly) {
          result.main.push({ pattern: patternOnly[1], action: 'print' });
        } else {
          // Condition { action }
          const condAction = remaining.match(/^([^{]+)\{([^}]*)\}$/);
          if (condAction) {
            result.main.push({ pattern: condAction[1].trim(), action: condAction[2].trim() });
          } else if (!remaining.includes('{')) {
            // Condition only (no action) - NR==2 or similar - default action is print
            // Or just a print expression like: print $1
            if (remaining.startsWith('print') || remaining.startsWith('printf')) {
              result.main.push({ pattern: null, action: remaining });
            } else {
              // It's a condition without action - default to print
              result.main.push({ pattern: remaining, action: 'print' });
            }
          }
        }
      }
    }
  }

  // Default action is print if no action specified
  if (result.main.length === 0 && !result.begin && !result.end) {
    result.main.push({ pattern: null, action: 'print' });
  }

  return result;
}

function matchesPattern(pattern: string | null, ctx: AwkContext): boolean {
  if (pattern === null) return true;

  // Regex pattern (explicit /pattern/)
  if (pattern.startsWith('/') && pattern.endsWith('/')) {
    const regex = new RegExp(pattern.slice(1, -1));
    return regex.test(ctx.line);
  }

  // Check if it looks like a condition (contains comparison operators or starts with NR/NF/$)
  if (/^(NR|NF|\$\d+)\s*(==|!=|>|<|>=|<=|~)/.test(pattern) ||
      /\s*(==|!=|>|<|>=|<=)\s*/.test(pattern)) {
    return evaluateCondition(pattern, ctx);
  }

  // Try as regex (for patterns without slashes)
  try {
    const regex = new RegExp(pattern);
    return regex.test(ctx.line);
  } catch {
    // Condition expression
    return evaluateCondition(pattern, ctx);
  }
}

function evaluateCondition(condition: string, ctx: AwkContext): boolean {
  condition = condition.trim();

  // Handle && (AND) conditions
  if (condition.includes('&&')) {
    const parts = condition.split('&&').map(p => p.trim());
    return parts.every(part => evaluateCondition(part, ctx));
  }

  // Handle || (OR) conditions
  if (condition.includes('||')) {
    const parts = condition.split('||').map(p => p.trim());
    return parts.some(part => evaluateCondition(part, ctx));
  }

  // Handle NR comparisons: NR == n, NR > n, etc.
  const nrMatch = condition.match(/^NR\s*(==|!=|>|<|>=|<=)\s*(\d+)$/);
  if (nrMatch) {
    const op = nrMatch[1];
    const val = parseInt(nrMatch[2], 10);
    return compareValues(ctx.NR, op, val);
  }

  // Handle $n ~ /pattern/
  const fieldRegex = condition.match(/^\$(\d+)\s*~\s*\/([^/]+)\/$/);
  if (fieldRegex) {
    const fieldNum = parseInt(fieldRegex[1], 10);
    const pattern = fieldRegex[2];
    const fieldVal = fieldNum === 0 ? ctx.line : (ctx.fields[fieldNum - 1] || '');
    return new RegExp(pattern).test(fieldVal);
  }

  // Handle $n == "value"
  const fieldStrEq = condition.match(/^\$(\d+)\s*==\s*"([^"]*)"$/);
  if (fieldStrEq) {
    const fieldNum = parseInt(fieldStrEq[1], 10);
    const value = fieldStrEq[2];
    const fieldVal = fieldNum === 0 ? ctx.line : (ctx.fields[fieldNum - 1] || '');
    return fieldVal === value;
  }

  // Handle generic comparisons: expr op expr (e.g., $3>max, $1==100, NF>2)
  const compMatch = condition.match(/^(.+?)\s*(==|!=|>=|<=|>|<)\s*(.+)$/);
  if (compMatch) {
    const leftExpr = compMatch[1].trim();
    const op = compMatch[2];
    const rightExpr = compMatch[3].trim();

    const leftVal = evaluateConditionExpr(leftExpr, ctx);
    const rightVal = evaluateConditionExpr(rightExpr, ctx);

    return compareValues(leftVal, op, rightVal);
  }

  return true;
}

function evaluateConditionExpr(expr: string, ctx: AwkContext): number | string {
  expr = expr.trim();

  // Field reference $n
  const fieldMatch = expr.match(/^\$(\d+)$/);
  if (fieldMatch) {
    const n = parseInt(fieldMatch[1], 10);
    if (n === 0) return ctx.line;
    const val = ctx.fields[n - 1] || '';
    // Try to convert to number if it looks like one
    const num = parseFloat(val);
    return isNaN(num) ? val : num;
  }

  // Built-in variables
  if (expr === 'NR') return ctx.NR;
  if (expr === 'NF') return ctx.NF;

  // User variables
  if (ctx.vars[expr] !== undefined) {
    const val = ctx.vars[expr];
    if (typeof val === 'number') return val;
    const num = parseFloat(String(val));
    return isNaN(num) ? val : num;
  }

  // Number literal
  const num = parseFloat(expr);
  if (!isNaN(num)) return num;

  // String literal with quotes
  if (expr.startsWith('"') && expr.endsWith('"')) {
    return expr.slice(1, -1);
  }

  // Uninitialized variable (looks like identifier) - return 0 in numeric context
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
    return 0;
  }

  return expr;
}

function compareValues(left: number | string, op: string, right: number | string): boolean {
  // Convert to numbers for comparison if both can be numbers
  const leftNum = typeof left === 'number' ? left : parseFloat(String(left));
  const rightNum = typeof right === 'number' ? right : parseFloat(String(right));

  const useNumeric = !isNaN(leftNum) && !isNaN(rightNum);

  if (useNumeric) {
    switch (op) {
      case '==': return leftNum === rightNum;
      case '!=': return leftNum !== rightNum;
      case '>': return leftNum > rightNum;
      case '<': return leftNum < rightNum;
      case '>=': return leftNum >= rightNum;
      case '<=': return leftNum <= rightNum;
    }
  } else {
    // String comparison
    const leftStr = String(left);
    const rightStr = String(right);
    switch (op) {
      case '==': return leftStr === rightStr;
      case '!=': return leftStr !== rightStr;
      case '>': return leftStr > rightStr;
      case '<': return leftStr < rightStr;
      case '>=': return leftStr >= rightStr;
      case '<=': return leftStr <= rightStr;
    }
  }
  return false;
}

function executeAwkAction(action: string, ctx: AwkContext): string {
  let output = '';

  // Split by semicolons for multiple statements
  const statements = action.split(';').map(s => s.trim()).filter(s => s);

  for (const stmt of statements) {
    // Handle print statement
    if (stmt === 'print' || stmt === 'print $0') {
      output += ctx.line + '\n';
    } else if (stmt.startsWith('print ')) {
      const printArgs = stmt.slice(6).trim();
      output += evaluatePrintArgs(printArgs, ctx) + '\n';
    } else if (stmt.startsWith('printf ')) {
      // Basic printf support
      const printfArgs = stmt.slice(7).trim();
      output += evaluatePrintf(printfArgs, ctx);
    }
    // Handle increment/decrement: var++, var--, ++var, --var
    else if (stmt.match(/^(\w+)\+\+$/)) {
      const varName = stmt.slice(0, -2);
      const current = Number(ctx.vars[varName]) || 0;
      ctx.vars[varName] = current + 1;
    } else if (stmt.match(/^(\w+)--$/)) {
      const varName = stmt.slice(0, -2);
      const current = Number(ctx.vars[varName]) || 0;
      ctx.vars[varName] = current - 1;
    } else if (stmt.match(/^\+\+(\w+)$/)) {
      const varName = stmt.slice(2);
      const current = Number(ctx.vars[varName]) || 0;
      ctx.vars[varName] = current + 1;
    } else if (stmt.match(/^--(\w+)$/)) {
      const varName = stmt.slice(2);
      const current = Number(ctx.vars[varName]) || 0;
      ctx.vars[varName] = current - 1;
    }
    // Handle compound assignment: +=, -=, *=, /=
    else if (stmt.includes('+=')) {
      const eqIdx = stmt.indexOf('+=');
      const varName = stmt.slice(0, eqIdx).trim();
      const expr = stmt.slice(eqIdx + 2).trim();
      const current = Number(ctx.vars[varName]) || 0;
      const value = Number(evaluateExpression(expr, ctx)) || 0;
      ctx.vars[varName] = current + value;
    } else if (stmt.includes('-=')) {
      const eqIdx = stmt.indexOf('-=');
      const varName = stmt.slice(0, eqIdx).trim();
      const expr = stmt.slice(eqIdx + 2).trim();
      const current = Number(ctx.vars[varName]) || 0;
      const value = Number(evaluateExpression(expr, ctx)) || 0;
      ctx.vars[varName] = current - value;
    } else if (stmt.includes('*=')) {
      const eqIdx = stmt.indexOf('*=');
      const varName = stmt.slice(0, eqIdx).trim();
      const expr = stmt.slice(eqIdx + 2).trim();
      const current = Number(ctx.vars[varName]) || 0;
      const value = Number(evaluateExpression(expr, ctx)) || 0;
      ctx.vars[varName] = current * value;
    } else if (stmt.includes('/=')) {
      const eqIdx = stmt.indexOf('/=');
      const varName = stmt.slice(0, eqIdx).trim();
      const expr = stmt.slice(eqIdx + 2).trim();
      const current = Number(ctx.vars[varName]) || 0;
      const value = Number(evaluateExpression(expr, ctx)) || 0;
      ctx.vars[varName] = value !== 0 ? current / value : 0;
    }
    // Simple variable assignment (must check after compound assignments)
    else if (stmt.includes('=') && !stmt.includes('==') && !stmt.includes('!=') &&
             !stmt.includes('>=') && !stmt.includes('<=')) {
      const eqIdx = stmt.indexOf('=');
      const varName = stmt.slice(0, eqIdx).trim();
      const expr = stmt.slice(eqIdx + 1).trim();
      ctx.vars[varName] = evaluateExpression(expr, ctx);
    }
  }

  return output;
}

function evaluatePrintArgs(args: string, ctx: AwkContext): string {
  const parts: string[] = [];

  // Handle comma-separated arguments
  const argList = splitPrintArgs(args);

  for (const arg of argList) {
    parts.push(String(evaluateExpression(arg.trim(), ctx)));
  }

  return parts.join(ctx.OFS);
}

function splitPrintArgs(args: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = false;
  let depth = 0;

  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (ch === '"' && args[i - 1] !== '\\') {
      inQuote = !inQuote;
      current += ch;
    } else if (ch === '(' && !inQuote) {
      depth++;
      current += ch;
    } else if (ch === ')' && !inQuote) {
      depth--;
      current += ch;
    } else if (ch === ',' && !inQuote && depth === 0) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);

  return result;
}

function evaluateExpression(expr: string, ctx: AwkContext): string | number {
  expr = expr.trim();

  // String literal
  if (expr.startsWith('"') && expr.endsWith('"')) {
    return expr.slice(1, -1);
  }

  // Field reference $n
  const fieldMatch = expr.match(/^\$(\d+)$/);
  if (fieldMatch) {
    const n = parseInt(fieldMatch[1], 10);
    if (n === 0) return ctx.line;
    return ctx.fields[n - 1] || '';
  }

  // NR, NF
  if (expr === 'NR') return ctx.NR;
  if (expr === 'NF') return ctx.NF;
  if (expr === 'FS') return ctx.FS;
  if (expr === 'OFS') return ctx.OFS;

  // Variable (defined)
  if (ctx.vars[expr] !== undefined) {
    return ctx.vars[expr];
  }

  // Arithmetic - check BEFORE concatenation to handle $1 + $2 and sum/count
  // First try with spaces (to properly handle $1 + $2 vs $1+$2 concatenation)
  const arithMatchSpaced = expr.match(/^(.+?)\s+([\+\-\*\/\%])\s+(.+)$/);
  if (arithMatchSpaced) {
    const left = Number(evaluateExpression(arithMatchSpaced[1], ctx));
    const right = Number(evaluateExpression(arithMatchSpaced[3], ctx));
    switch (arithMatchSpaced[2]) {
      case '+': return left + right;
      case '-': return left - right;
      case '*': return left * right;
      case '/': return right !== 0 ? left / right : 0;
      case '%': return left % right;
    }
  }

  // Also check for arithmetic without spaces (sum/count, a*b) but only for simple identifiers/numbers
  const arithMatchNoSpace = expr.match(/^([a-zA-Z_]\w*|\$\d+|\d+(?:\.\d+)?)\s*([\*\/\%])\s*([a-zA-Z_]\w*|\$\d+|\d+(?:\.\d+)?)$/);
  if (arithMatchNoSpace) {
    const left = Number(evaluateExpression(arithMatchNoSpace[1], ctx));
    const right = Number(evaluateExpression(arithMatchNoSpace[3], ctx));
    switch (arithMatchNoSpace[2]) {
      case '*': return left * right;
      case '/': return right !== 0 ? left / right : 0;
      case '%': return left % right;
    }
  }

  // Concatenation (strings next to each other without arithmetic operators)
  if (expr.includes('$') || expr.includes('"')) {
    return evaluateConcatenation(expr, ctx);
  }

  // Number
  if (/^-?\d+(\.\d+)?$/.test(expr)) {
    return parseFloat(expr);
  }

  // Uninitialized variable (looks like identifier) - return empty string
  if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(expr)) {
    return '';
  }

  return expr;
}

function evaluateConcatenation(expr: string, ctx: AwkContext): string {
  let result = '';
  let i = 0;

  while (i < expr.length) {
    // Skip whitespace
    while (i < expr.length && /\s/.test(expr[i])) i++;
    if (i >= expr.length) break;

    if (expr[i] === '"') {
      // String literal
      let str = '';
      i++; // skip opening quote
      while (i < expr.length && expr[i] !== '"') {
        str += expr[i++];
      }
      i++; // skip closing quote
      result += str;
    } else if (expr[i] === '$') {
      // Field reference
      i++; // skip $
      let numStr = '';
      while (i < expr.length && /\d/.test(expr[i])) {
        numStr += expr[i++];
      }
      const n = parseInt(numStr, 10);
      result += n === 0 ? ctx.line : (ctx.fields[n - 1] || '');
    } else {
      // Variable or literal
      let token = '';
      while (i < expr.length && !/[\s\$"]/.test(expr[i])) {
        token += expr[i++];
      }
      if (token === 'NR') result += ctx.NR;
      else if (token === 'NF') result += ctx.NF;
      else if (ctx.vars[token] !== undefined) result += ctx.vars[token];
      else result += token;
    }
  }

  return result;
}

function evaluatePrintf(args: string, ctx: AwkContext): string {
  // Very basic printf - just handles %s and %d
  const match = args.match(/^"([^"]*)"(.*)$/);
  if (!match) return '';

  let format = match[1];
  const restArgs = match[2].trim();
  const values = restArgs ? splitPrintArgs(restArgs.replace(/^,\s*/, '')) : [];

  let valueIdx = 0;
  let result = '';
  let i = 0;

  while (i < format.length) {
    if (format[i] === '%' && i + 1 < format.length) {
      const spec = format[i + 1];
      if (spec === 's' || spec === 'd') {
        const val = values[valueIdx] ? evaluateExpression(values[valueIdx], ctx) : '';
        result += String(val);
        valueIdx++;
        i += 2;
      } else if (spec === '%') {
        result += '%';
        i += 2;
      } else {
        result += format[i++];
      }
    } else if (format[i] === '\\' && i + 1 < format.length) {
      const esc = format[i + 1];
      if (esc === 'n') result += '\n';
      else if (esc === 't') result += '\t';
      else result += esc;
      i += 2;
    } else {
      result += format[i++];
    }
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function processEscapes(str: string): string {
  return str
    .replace(/\\t/g, '\t')
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\');
}
