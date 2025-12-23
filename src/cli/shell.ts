#!/usr/bin/env node
/**
 * Interactive virtual shell CLI
 *
 * Usage:
 *   npx tsx src/cli/shell.ts [--cwd <dir>] [--files <json-file>]
 *
 * This provides an interactive shell experience using BashEnv's virtual filesystem.
 */

import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { BashEnv } from '../BashEnv.js';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

interface ShellOptions {
  cwd?: string;
  files?: Record<string, string>;
  env?: Record<string, string>;
}

class VirtualShell {
  private env: BashEnv;
  private rl: readline.Interface;
  private running = true;
  private history: string[] = [];

  private isInteractive: boolean;

  constructor(options: ShellOptions = {}) {
    // Default files to create a basic environment
    const defaultFiles: Record<string, string> = {
      '/home/user/.bashrc': '# Virtual shell\nexport PS1="\\u@virtual:\\w$ "\n',
      '/home/user/.profile': '# User profile\n',
      '/tmp/.keep': '',
    };

    this.env = new BashEnv({
      files: { ...defaultFiles, ...options.files },
      cwd: options.cwd || '/home/user',
      env: {
        HOME: '/home/user',
        USER: 'user',
        SHELL: '/bin/bash',
        TERM: 'xterm-256color',
        ...options.env,
      },
    });

    // Check if stdin is a TTY (interactive mode)
    this.isInteractive = process.stdin.isTTY === true;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: this.isInteractive,
    });

    // Handle Ctrl+C
    this.rl.on('SIGINT', () => {
      process.stdout.write('^C\n');
      this.prompt();
    });

    // Handle close (only in interactive mode)
    if (process.stdin.isTTY) {
      this.rl.on('close', () => {
        this.running = false;
        console.log('\nGoodbye!');
        process.exit(0);
      });
    }
  }

  private getPrompt(): string {
    const cwd = this.env.getCwd();
    const home = this.env.getEnv().HOME || '/home/user';

    // Replace home with ~
    let displayCwd = cwd;
    if (cwd === home) {
      displayCwd = '~';
    } else if (cwd.startsWith(home + '/')) {
      displayCwd = '~' + cwd.slice(home.length);
    }

    return `${colors.green}${colors.bold}user@virtual${colors.reset}:${colors.blue}${colors.bold}${displayCwd}${colors.reset}$ `;
  }

  private async executeCommand(command: string): Promise<void> {
    const trimmed = command.trim();

    // Skip empty commands
    if (!trimmed) {
      return;
    }

    // Add to history
    this.history.push(trimmed);

    // Handle shell built-ins that need special treatment
    if (trimmed === 'exit' || trimmed.startsWith('exit ')) {
      const parts = trimmed.split(/\s+/);
      const exitCode = parts[1] ? parseInt(parts[1], 10) : 0;
      console.log('exit');
      process.exit(exitCode);
    }

    if (trimmed === 'clear') {
      console.clear();
      return;
    }

    if (trimmed === 'history') {
      this.history.forEach((cmd, i) => {
        console.log(`  ${i + 1}  ${cmd}`);
      });
      return;
    }

    if (trimmed === 'help') {
      this.printHelp();
      return;
    }

    // Execute command in BashEnv
    try {
      const result = await this.env.exec(trimmed);

      if (result.stdout) {
        process.stdout.write(result.stdout);
      }

      if (result.stderr) {
        process.stderr.write(`${colors.red}${result.stderr}${colors.reset}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${colors.red}Error: ${message}${colors.reset}`);
    }
  }

  private printHelp(): void {
    console.log(`
${colors.bold}Virtual Shell - BashEnv Interactive Mode${colors.reset}

This is a simulated bash environment running entirely in-memory.
All commands operate on a virtual filesystem.

${colors.bold}Built-in shell commands:${colors.reset}
  exit [code]    Exit the shell with optional exit code
  clear          Clear the terminal screen
  history        Show command history
  help           Show this help message

${colors.bold}Available commands:${colors.reset}
  echo, cat, ls, cd, pwd, mkdir, touch, rm, cp, mv,
  head, tail, wc, grep, sort, uniq, find, sed, cut, tr,
  true, false

${colors.bold}Supported features:${colors.reset}
  - Pipes: cmd1 | cmd2
  - Redirections: >, >>, 2>, 2>&1, <
  - Command chaining: &&, ||, ;
  - Variables: $VAR, \${VAR}, \${VAR:-default}
  - Glob patterns: *, ?, [...]

${colors.bold}Example commands:${colors.reset}
  ls -la
  echo "Hello" > file.txt
  cat file.txt | grep Hello
  find . -name "*.txt"
`);
  }

  private printWelcome(): void {
    console.log(`
${colors.cyan}${colors.bold}╔══════════════════════════════════════════════════════════════╗
║                    Virtual Shell v1.0                         ║
║            A simulated bash environment in TypeScript         ║
╚══════════════════════════════════════════════════════════════╝${colors.reset}

Type ${colors.green}help${colors.reset} for available commands, ${colors.green}exit${colors.reset} to quit.
All operations run on a virtual in-memory filesystem.
`);
  }

  private prompt(): void {
    this.rl.question(this.getPrompt(), async (answer) => {
      if (!this.running) return;

      await this.executeCommand(answer);
      this.prompt();
    });
  }

  async run(): Promise<void> {
    if (this.isInteractive) {
      this.printWelcome();
      this.prompt();
    } else {
      // Non-interactive mode: read and execute line by line sequentially
      const lines: string[] = [];

      // Collect all lines first
      this.rl.on('line', (line) => {
        lines.push(line);
      });

      // Wait for all input to be read
      await new Promise<void>((resolve) => {
        this.rl.on('close', resolve);
      });

      // Execute commands sequentially
      for (const line of lines) {
        await this.executeCommand(line);
      }
    }
  }
}

// CLI argument parsing
function parseArgs(): ShellOptions {
  const args = process.argv.slice(2);
  const options: ShellOptions = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cwd' && args[i + 1]) {
      options.cwd = args[++i];
    } else if (args[i] === '--files' && args[i + 1]) {
      const filePath = args[++i];
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        options.files = JSON.parse(content);
      } catch (error) {
        console.error(`Error reading files from ${filePath}:`, error);
        process.exit(1);
      }
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`
Usage: npx tsx src/cli/shell.ts [options]

Options:
  --cwd <dir>         Set initial working directory (default: /home/user)
  --files <json>      Load initial files from JSON file
  --help, -h          Show this help message

Example:
  npx tsx src/cli/shell.ts --cwd /app --files ./my-files.json
`);
      process.exit(0);
    }
  }

  return options;
}

// Main entry point
const options = parseArgs();
const shell = new VirtualShell(options);
shell.run();
