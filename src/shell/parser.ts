/**
 * Shell Parser - Tokenizes and parses shell command lines
 *
 * Handles:
 * - Quoting (single, double)
 * - Escape sequences
 * - Redirections (>, >>, 2>, 2>&1, 2>/dev/null, <)
 * - Pipelines (|)
 * - Command chaining (&&, ||, ;)
 * - Variable expansion ($VAR, ${VAR}, ${VAR:-default})
 * - Glob patterns (*, ?, [...])
 */

export interface Redirection {
  type: 'stdout' | 'stderr' | 'stdin' | 'stderr-to-stdout';
  target: string | null; // null for 2>&1
  append: boolean;
}

export interface ParsedCommand {
  command: string;
  args: string[];
  /** Tracks which args were quoted (should not be glob-expanded) */
  quotedArgs: boolean[];
  redirections: Redirection[];
}

export interface ChainedCommand {
  parsed: ParsedCommand;
  operator: '' | '&&' | '||' | ';';
  /**
   * Number of ! operators before this pipeline segment.
   * Odd count = negate, even count = no change.
   * Only meaningful on the first command of a pipeline segment.
   */
  negationCount?: number;
}

export interface Pipeline {
  commands: ChainedCommand[];
}

type TokenType =
  | 'word'
  | 'pipe'
  | 'and'
  | 'or'
  | 'semicolon'
  | 'not'
  | 'redirect-stdout'
  | 'redirect-stdout-append'
  | 'redirect-stderr'
  | 'redirect-stderr-append'
  | 'redirect-stderr-to-stdout'
  | 'redirect-stdin'
  | 'if'
  | 'then'
  | 'elif'
  | 'else'
  | 'fi';

interface Token {
  type: TokenType;
  value: string;
  /** True if the token was quoted (should not be glob-expanded). Only relevant for 'word' tokens. */
  quoted?: boolean;
}

export class ShellParser {
  private env: Record<string, string>;

  constructor(env: Record<string, string> = {}) {
    this.env = env;
  }

  setEnv(env: Record<string, string>): void {
    this.env = env;
  }

  /**
   * Parse a full command line into pipelines
   */
  parse(commandLine: string): Pipeline[] {
    const tokens = this.tokenize(commandLine);
    return this.buildPipelines(tokens);
  }

  /**
   * Tokenize a command line into tokens
   */
  private tokenize(input: string): Token[] {
    const tokens: Token[] = [];
    let i = 0;
    let current = '';
    let inQuote: string | null = null;
    let wasQuoted = false; // Track if current token contains any quoted content

    const pushWord = () => {
      if (current) {
        tokens.push({ type: 'word', value: current, quoted: wasQuoted });
        current = '';
        wasQuoted = false;
      }
    };

    while (i < input.length) {
      const char = input[i];
      const nextChar = input[i + 1];

      // Handle escape sequences
      if (char === '\\' && i + 1 < input.length) {
        if (inQuote === "'") {
          // In single quotes, backslash is literal
          current += char;
          i++;
        } else if (inQuote === '"') {
          // In double quotes, only certain escapes are special
          if (nextChar === '"' || nextChar === '\\' || nextChar === '$' || nextChar === '`') {
            current += nextChar;
            i += 2;
          } else {
            current += char;
            i++;
          }
        } else {
          // Outside quotes, backslash escapes next character
          current += nextChar;
          i += 2;
        }
        continue;
      }

      // Handle variable expansion (not in single quotes)
      // Note: We preserve $VAR syntax here and expand later in execution
      // This allows commands like "local x=1; echo $x" to work correctly
      if (char === '$' && inQuote !== "'") {
        // In double quotes, we still need to expand to handle ${VAR:-default} etc.
        // But for simple $VAR, preserve for later expansion
        if (inQuote === '"') {
          const { value, endIndex } = this.expandVariable(input, i);
          current += value;
          i = endIndex;
          continue;
        }
        // Outside quotes, preserve the $ for later expansion
        current += char;
        i++;
        continue;
      }

      // Handle quotes
      if (char === '"' || char === "'") {
        if (inQuote === char) {
          inQuote = null;
        } else if (!inQuote) {
          inQuote = char;
          wasQuoted = true; // Mark that this token contains quoted content
        } else {
          current += char;
        }
        i++;
        continue;
      }

      // Inside quotes, everything is literal (except what we handled above)
      if (inQuote) {
        current += char;
        i++;
        continue;
      }

      // Handle operators and redirections (only outside quotes)

      // Handle 2>&1
      if (char === '2' && input.slice(i, i + 4) === '2>&1') {
        pushWord();
        tokens.push({ type: 'redirect-stderr-to-stdout', value: '2>&1' });
        i += 4;
        continue;
      }

      // Handle 2>> (stderr append)
      if (char === '2' && nextChar === '>' && input[i + 2] === '>') {
        pushWord();
        tokens.push({ type: 'redirect-stderr-append', value: '2>>' });
        i += 3;
        continue;
      }

      // Handle 2> (stderr)
      if (char === '2' && nextChar === '>') {
        pushWord();
        tokens.push({ type: 'redirect-stderr', value: '2>' });
        i += 2;
        continue;
      }

      // Handle >> (stdout append)
      if (char === '>' && nextChar === '>') {
        pushWord();
        tokens.push({ type: 'redirect-stdout-append', value: '>>' });
        i += 2;
        continue;
      }

      // Handle > (stdout)
      if (char === '>') {
        pushWord();
        tokens.push({ type: 'redirect-stdout', value: '>' });
        i++;
        continue;
      }

      // Handle < (stdin)
      if (char === '<') {
        pushWord();
        tokens.push({ type: 'redirect-stdin', value: '<' });
        i++;
        continue;
      }

      // Handle &&
      if (char === '&' && nextChar === '&') {
        pushWord();
        tokens.push({ type: 'and', value: '&&' });
        i += 2;
        continue;
      }

      // Handle ||
      if (char === '|' && nextChar === '|') {
        pushWord();
        tokens.push({ type: 'or', value: '||' });
        i += 2;
        continue;
      }

      // Handle | (pipe)
      if (char === '|') {
        pushWord();
        tokens.push({ type: 'pipe', value: '|' });
        i++;
        continue;
      }

      // Handle ;
      if (char === ';') {
        pushWord();
        tokens.push({ type: 'semicolon', value: ';' });
        i++;
        continue;
      }

      // Handle ! (negation operator) - only at start of command or after operator
      if (char === '!' && (current === '' || tokens.length === 0 ||
          ['and', 'or', 'semicolon', 'pipe'].includes(tokens[tokens.length - 1]?.type))) {
        // Check if followed by space or end (command negation)
        if (i + 1 >= input.length || input[i + 1] === ' ' || input[i + 1] === '\t') {
          pushWord();
          tokens.push({ type: 'not', value: '!' });
          i++;
          continue;
        }
      }

      // Handle whitespace
      if (char === ' ' || char === '\t') {
        pushWord();
        i++;
        continue;
      }

      // Regular character
      current += char;
      i++;
    }

    pushWord();
    return tokens;
  }

  /**
   * Expand a variable starting at position i
   */
  private expandVariable(str: string, startIndex: number): { value: string; endIndex: number } {
    let i = startIndex + 1; // Skip the $

    if (i >= str.length) {
      return { value: '$', endIndex: i };
    }

    // Handle ${VAR} and ${VAR:-default}
    if (str[i] === '{') {
      const closeIndex = str.indexOf('}', i);
      if (closeIndex === -1) {
        return { value: '${', endIndex: i + 1 };
      }
      const content = str.slice(i + 1, closeIndex);

      // Handle ${VAR:-default}
      const defaultMatch = content.match(/^([^:]+):-(.*)$/);
      if (defaultMatch) {
        const [, varName, defaultValue] = defaultMatch;
        return {
          value: this.env[varName] ?? defaultValue,
          endIndex: closeIndex + 1,
        };
      }
      return {
        value: this.env[content] ?? '',
        endIndex: closeIndex + 1,
      };
    }

    // Handle special variables: $@, $#, $$, $?, $!, $*
    if ('@#$?!*'.includes(str[i])) {
      return {
        value: this.env[str[i]] ?? '',
        endIndex: i + 1,
      };
    }

    // Handle positional parameters: $0, $1, $2, ...
    if (/[0-9]/.test(str[i])) {
      return {
        value: this.env[str[i]] ?? '',
        endIndex: i + 1,
      };
    }

    // Handle $VAR - must start with letter or underscore
    let varName = '';
    // First char must be letter or underscore
    if (/[A-Za-z_]/.test(str[i])) {
      varName += str[i];
      i++;
      // Subsequent chars can include digits
      while (i < str.length && /[A-Za-z0-9_]/.test(str[i])) {
        varName += str[i];
        i++;
      }
    }

    if (!varName) {
      return { value: '$', endIndex: startIndex + 1 };
    }

    return {
      value: this.env[varName] ?? '',
      endIndex: i,
    };
  }

  /**
   * Collect tokens for a compound command (if...fi, while...done, etc.)
   */
  private collectCompoundCommand(
    tokens: Token[],
    startIndex: number,
    startKeyword: string,
    endKeyword: string
  ): { text: string; endIndex: number } {
    let depth = 0;
    let text = '';
    let i = startIndex;

    while (i < tokens.length) {
      const token = tokens[i];
      const tokenText = token.type === 'word' ? token.value : this.tokenToText(token);

      if (token.type === 'word' && token.value === startKeyword) {
        depth++;
      } else if (token.type === 'word' && token.value === endKeyword) {
        depth--;
        if (depth === 0) {
          text += tokenText;
          return { text, endIndex: i };
        }
      }

      text += tokenText;

      // Add space after most tokens, but handle operators specially
      if (i + 1 < tokens.length) {
        const nextToken = tokens[i + 1];
        if (token.type === 'word' && nextToken.type === 'word') {
          text += ' ';
        } else if (token.type !== 'semicolon' && nextToken.type !== 'semicolon') {
          text += ' ';
        }
      }

      i++;
    }

    // Unclosed compound command
    return { text, endIndex: i - 1 };
  }

  /**
   * Convert a token back to its text representation
   */
  private tokenToText(token: Token): string {
    switch (token.type) {
      case 'pipe': return '|';
      case 'and': return '&&';
      case 'or': return '||';
      case 'semicolon': return ';';
      case 'redirect-stdout': return '>';
      case 'redirect-stdout-append': return '>>';
      case 'redirect-stderr': return '2>';
      case 'redirect-stderr-append': return '2>>';
      case 'redirect-stderr-to-stdout': return '2>&1';
      case 'redirect-stdin': return '<';
      default: return token.value;
    }
  }

  /**
   * Build pipeline structures from tokens
   */
  private buildPipelines(tokens: Token[]): Pipeline[] {
    const pipelines: Pipeline[] = [];
    let currentPipeline: Pipeline = { commands: [] };
    let currentArgs: { value: string; quoted: boolean }[] = [];
    let currentRedirections: Redirection[] = [];
    let lastOperator: '' | '&&' | '||' | ';' = '';
    let negationCount = 0; // Count of ! operators for current pipeline segment

    const pushCommand = () => {
      if (currentArgs.length > 0) {
        const [commandArg, ...restArgs] = currentArgs;
        currentPipeline.commands.push({
          parsed: {
            command: commandArg.value,
            args: restArgs.map((a) => a.value),
            quotedArgs: restArgs.map((a) => a.quoted),
            redirections: currentRedirections,
          },
          operator: lastOperator,
          negationCount: negationCount > 0 ? negationCount : undefined,
        });
        currentArgs = [];
        currentRedirections = [];
        // Only reset negation after non-pipe operators (end of pipeline segment)
        // For pipes, negation applies to the whole pipeline segment
        if (lastOperator !== '') {
          negationCount = 0;
        }
      }
    };

    const pushPipeline = () => {
      pushCommand();
      if (currentPipeline.commands.length > 0) {
        pipelines.push(currentPipeline);
        currentPipeline = { commands: [] };
      }
    };

    let i = 0;
    while (i < tokens.length) {
      const token = tokens[i];

      switch (token.type) {
        case 'word':
          // Check for compound commands (if, while, for, case)
          if (token.value === 'if' && currentArgs.length === 0) {
            // Collect all tokens until matching 'fi'
            const compoundCmd = this.collectCompoundCommand(tokens, i, 'if', 'fi');
            currentArgs.push({ value: compoundCmd.text, quoted: true });
            i = compoundCmd.endIndex;
            continue;
          }
          currentArgs.push({ value: token.value, quoted: token.quoted ?? false });
          break;

        case 'pipe':
          pushCommand();
          lastOperator = '';
          break;

        case 'and':
          pushCommand();
          lastOperator = '&&';
          negationCount = 0; // Reset for next pipeline segment
          break;

        case 'or':
          pushCommand();
          lastOperator = '||';
          negationCount = 0; // Reset for next pipeline segment
          break;

        case 'semicolon':
          pushCommand();
          lastOperator = ';';
          negationCount = 0; // Reset for next pipeline segment
          break;

        case 'not':
          // Increment negation count - odd count means negate
          negationCount++;
          break;

        case 'redirect-stdout':
        case 'redirect-stdout-append':
          // Next token should be the target
          if (i + 1 < tokens.length && tokens[i + 1].type === 'word') {
            currentRedirections.push({
              type: 'stdout',
              target: tokens[i + 1].value,
              append: token.type === 'redirect-stdout-append',
            });
            i++;
          }
          break;

        case 'redirect-stderr':
        case 'redirect-stderr-append':
          // Next token should be the target
          if (i + 1 < tokens.length && tokens[i + 1].type === 'word') {
            currentRedirections.push({
              type: 'stderr',
              target: tokens[i + 1].value,
              append: token.type === 'redirect-stderr-append',
            });
            i++;
          }
          break;

        case 'redirect-stderr-to-stdout':
          currentRedirections.push({
            type: 'stderr-to-stdout',
            target: null,
            append: false,
          });
          break;

        case 'redirect-stdin':
          // Next token should be the source
          if (i + 1 < tokens.length && tokens[i + 1].type === 'word') {
            currentRedirections.push({
              type: 'stdin',
              target: tokens[i + 1].value,
              append: false,
            });
            i++;
          }
          break;
      }

      i++;
    }

    pushPipeline();
    return pipelines;
  }

  /**
   * Check if a string contains glob characters
   */
  isGlobPattern(str: string): boolean {
    return str.includes('*') || str.includes('?') || /\[.*\]/.test(str);
  }
}
