import { VirtualFs, IFileSystem } from './fs.js';
import { Command, CommandContext, CommandRegistry, ExecResult } from './types.js';
import { ShellParser, Pipeline, Redirection } from './shell/index.js';
import { GlobExpander } from './shell/index.js';

// Import commands
import { echoCommand } from './commands/echo/echo.js';
import { catCommand } from './commands/cat/cat.js';
import { lsCommand } from './commands/ls/ls.js';
import { mkdirCommand } from './commands/mkdir/mkdir.js';
import { pwdCommand } from './commands/pwd/pwd.js';
import { touchCommand } from './commands/touch/touch.js';
import { rmCommand } from './commands/rm/rm.js';
import { cpCommand } from './commands/cp/cp.js';
import { mvCommand } from './commands/mv/mv.js';
import { headCommand } from './commands/head/head.js';
import { tailCommand } from './commands/tail/tail.js';
import { wcCommand } from './commands/wc/wc.js';
import { grepCommand } from './commands/grep/grep.js';
import { sortCommand } from './commands/sort/sort.js';
import { uniqCommand } from './commands/uniq/uniq.js';
import { findCommand } from './commands/find/find.js';
import { sedCommand } from './commands/sed/sed.js';
import { cutCommand } from './commands/cut/cut.js';
import { trCommand } from './commands/tr/tr.js';
import { trueCommand, falseCommand } from './commands/true/true.js';

export interface BashEnvOptions {
  /**
   * Initial files to populate the virtual filesystem.
   * Only used when fs is not provided.
   */
  files?: Record<string, string>;
  /**
   * Environment variables
   */
  env?: Record<string, string>;
  /**
   * Initial working directory
   */
  cwd?: string;
  /**
   * Custom filesystem implementation.
   * If provided, 'files' option is ignored.
   * Defaults to VirtualFs if not provided.
   */
  fs?: IFileSystem;
}

export class BashEnv {
  private fs: IFileSystem;
  private cwd: string;
  private env: Record<string, string>;
  private commands: CommandRegistry = new Map();
  private previousDir: string = '/';
  private parser: ShellParser;

  constructor(options: BashEnvOptions = {}) {
    // Use provided filesystem or create a new VirtualFs
    const fs = options.fs ?? new VirtualFs(options.files);
    this.fs = fs;
    this.cwd = options.cwd || '/';
    this.env = { HOME: '/', PATH: '/bin', ...options.env };
    this.parser = new ShellParser(this.env);

    // Ensure cwd exists in the virtual filesystem
    if (this.cwd !== '/' && fs instanceof VirtualFs) {
      try {
        fs.mkdirSync(this.cwd, { recursive: true });
      } catch {
        // Ignore errors - the directory may already exist
      }
    }

    // Register built-in commands
    this.registerCommand(echoCommand);
    this.registerCommand(catCommand);
    this.registerCommand(lsCommand);
    this.registerCommand(mkdirCommand);
    this.registerCommand(pwdCommand);
    this.registerCommand(touchCommand);
    this.registerCommand(rmCommand);
    this.registerCommand(cpCommand);
    this.registerCommand(mvCommand);
    this.registerCommand(headCommand);
    this.registerCommand(tailCommand);
    this.registerCommand(wcCommand);
    this.registerCommand(grepCommand);
    this.registerCommand(sortCommand);
    this.registerCommand(uniqCommand);
    this.registerCommand(findCommand);
    this.registerCommand(sedCommand);
    this.registerCommand(cutCommand);
    this.registerCommand(trCommand);
    this.registerCommand(trueCommand);
    this.registerCommand(falseCommand);
  }

  registerCommand(command: Command): void {
    this.commands.set(command.name, command);
  }

  async exec(commandLine: string): Promise<ExecResult> {
    // Handle empty command
    if (!commandLine.trim()) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // Update parser with current environment
    this.parser.setEnv(this.env);

    // Parse the command line into pipelines
    const pipelines = this.parser.parse(commandLine);

    let stdin = '';
    let lastResult: ExecResult = { stdout: '', stderr: '', exitCode: 0 };

    // Execute each pipeline
    for (const pipeline of pipelines) {
      const result = await this.executePipeline(pipeline, stdin);
      stdin = result.stdout;
      lastResult = result;
    }

    return lastResult;
  }

  private async executePipeline(pipeline: Pipeline, initialStdin: string): Promise<ExecResult> {
    let stdin = initialStdin;
    let lastResult: ExecResult = { stdout: '', stderr: '', exitCode: 0 };
    let accumulatedStdout = '';
    let accumulatedStderr = '';

    for (let i = 0; i < pipeline.commands.length; i++) {
      const { parsed, operator } = pipeline.commands[i];
      const nextCommand = pipeline.commands[i + 1];
      const nextOperator = nextCommand?.operator || '';

      // Check if we should run based on previous result (for &&, ||, ;)
      if (operator === '&&' && lastResult.exitCode !== 0) continue;
      if (operator === '||' && lastResult.exitCode === 0) continue;
      // For ';', always run

      // Determine if previous command was a pipe (empty operator means pipe)
      const isPipedInput = operator === '';
      // Determine if next command is a pipe
      const isPipedOutput = nextOperator === '';

      // Execute the command
      const commandStdin = isPipedInput && i > 0 ? stdin : initialStdin;
      const result = await this.executeCommand(parsed.command, parsed.args, parsed.quotedArgs, parsed.redirections, commandStdin);

      // Handle stdout based on whether this is piped to next command
      if (isPipedOutput && i < pipeline.commands.length - 1) {
        // This command's stdout goes to next command's stdin
        stdin = result.stdout;
      } else {
        // Accumulate stdout for final output
        accumulatedStdout += result.stdout;
      }

      // Always accumulate stderr
      accumulatedStderr += result.stderr;

      // Update last result for operator checks
      lastResult = result;
    }

    return {
      stdout: accumulatedStdout,
      stderr: accumulatedStderr,
      exitCode: lastResult.exitCode,
    };
  }

  private async executeCommand(
    command: string,
    args: string[],
    quotedArgs: boolean[],
    redirections: Redirection[],
    stdin: string
  ): Promise<ExecResult> {
    if (!command) {
      return { stdout: '', stderr: '', exitCode: 0 };
    }

    // Create glob expander for this execution
    const globExpander = new GlobExpander(this.fs, this.cwd);

    // Expand glob patterns in arguments (skip quoted args)
    const expandedArgs = await globExpander.expandArgs(args, quotedArgs);

    // Handle built-in commands that modify shell state
    if (command === 'cd') {
      return this.handleCd(expandedArgs);
    }
    if (command === 'export') {
      return this.handleExport(expandedArgs);
    }
    if (command === 'unset') {
      return this.handleUnset(expandedArgs);
    }
    if (command === 'exit') {
      const code = expandedArgs[0] ? parseInt(expandedArgs[0], 10) : 0;
      return { stdout: '', stderr: '', exitCode: isNaN(code) ? 1 : code };
    }

    // Look up command
    const cmd = this.commands.get(command);
    if (!cmd) {
      return {
        stdout: '',
        stderr: `bash: ${command}: command not found\n`,
        exitCode: 127,
      };
    }

    // Execute the command
    const ctx: CommandContext = {
      fs: this.fs,
      cwd: this.cwd,
      env: this.env,
      stdin,
    };

    let result: ExecResult;
    try {
      result = await cmd.execute(expandedArgs, ctx);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = {
        stdout: '',
        stderr: `${command}: ${message}\n`,
        exitCode: 1,
      };
    }

    // Apply redirections
    result = await this.applyRedirections(result, redirections);

    return result;
  }

  private async applyRedirections(result: ExecResult, redirections: Redirection[]): Promise<ExecResult> {
    let { stdout, stderr, exitCode } = result;

    for (const redir of redirections) {
      switch (redir.type) {
        case 'stdout':
          if (redir.target) {
            const filePath = this.resolvePath(redir.target);
            if (redir.append) {
              await this.fs.appendFile(filePath, stdout);
            } else {
              await this.fs.writeFile(filePath, stdout);
            }
            stdout = '';
          }
          break;

        case 'stderr':
          if (redir.target === '/dev/null') {
            stderr = '';
          } else if (redir.target) {
            const filePath = this.resolvePath(redir.target);
            if (redir.append) {
              await this.fs.appendFile(filePath, stderr);
            } else {
              await this.fs.writeFile(filePath, stderr);
            }
            stderr = '';
          }
          break;

        case 'stderr-to-stdout':
          stdout += stderr;
          stderr = '';
          break;
      }
    }

    return { stdout, stderr, exitCode };
  }

  private async handleCd(args: string[]): Promise<ExecResult> {
    const target = args[0] || this.env.HOME || '/';

    let newDir: string;
    if (target === '-') {
      newDir = this.previousDir;
    } else if (target === '~') {
      newDir = this.env.HOME || '/';
    } else {
      newDir = this.resolvePath(target);
    }

    try {
      const stat = await this.fs.stat(newDir);
      if (!stat.isDirectory) {
        return { stdout: '', stderr: `cd: ${target}: Not a directory\n`, exitCode: 1 };
      }
      this.previousDir = this.cwd;
      this.cwd = newDir;
      return { stdout: '', stderr: '', exitCode: 0 };
    } catch {
      return { stdout: '', stderr: `cd: ${target}: No such file or directory\n`, exitCode: 1 };
    }
  }

  private handleExport(args: string[]): ExecResult {
    for (const arg of args) {
      const eqIndex = arg.indexOf('=');
      if (eqIndex > 0) {
        const name = arg.slice(0, eqIndex);
        const value = arg.slice(eqIndex + 1);
        this.env[name] = value;
      }
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private handleUnset(args: string[]): ExecResult {
    for (const arg of args) {
      delete this.env[arg];
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  }

  private resolvePath(path: string): string {
    return this.fs.resolvePath(this.cwd, path);
  }

  // Public API for file access
  async readFile(path: string): Promise<string> {
    return this.fs.readFile(this.resolvePath(path));
  }

  async writeFile(path: string, content: string): Promise<void> {
    return this.fs.writeFile(this.resolvePath(path), content);
  }

  getCwd(): string {
    return this.cwd;
  }

  getEnv(): Record<string, string> {
    return { ...this.env };
  }
}
