# bash-env

A simulated bash environment with an in-memory (pluggable) virtual filesystem, written in TypeScript.

Designed for agents exploring a filesystem with a "full" but secure bash tool.

## Installation

```bash
pnpm install
```

## Usage

### Programmatic API

```typescript
import { BashEnv } from "./src/BashEnv.js";

// Default layout: starts in /home/user with /bin, /tmp
const env = new BashEnv();
await env.exec('echo "Hello" > greeting.txt');
const result = await env.exec("cat greeting.txt");
console.log(result.stdout); // "Hello\n"

// Custom files: starts in / with only specified files
const custom = new BashEnv({
  files: { "/data/file.txt": "content" },
});
await custom.exec("cat /data/file.txt");

// With custom execution limits
const limited = new BashEnv({
  maxCallDepth: 50, // Max recursion depth (default: 100)
  maxLoopIterations: 5000, // Max loop iterations (default: 10000)
});
```

### Interactive Shell

```bash
pnpm shell
```

## Supported Commands

### File Operations

`cat`, `cp`, `ln`, `ls`, `mkdir`, `mv`, `readlink`, `rm`, `stat`, `touch`, `tree`

### Text Processing

`awk`, `cut`, `grep`, `head`, `printf`, `sed`, `sort`, `tail`, `tr`, `uniq`, `wc`, `xargs`

### Navigation & Environment

`basename`, `cd`, `dirname`, `du`, `echo`, `env`, `export`, `find`, `printenv`, `pwd`, `tee`

### Shell Utilities

`alias`, `bash`, `chmod`, `clear`, `false`, `history`, `sh`, `true`, `unalias`

All commands support `--help` for usage information.

## Shell Features

- **Pipes**: `cmd1 | cmd2`
- **Redirections**: `>`, `>>`, `2>`, `2>&1`, `<`
- **Command chaining**: `&&`, `||`, `;`
- **Variables**: `$VAR`, `${VAR}`, `${VAR:-default}`
- **Positional parameters**: `$1`, `$2`, `$@`, `$#`
- **Glob patterns**: `*`, `?`, `[...]`
- **If statements**: `if COND; then CMD; elif COND; then CMD; else CMD; fi`
- **Functions**: `function name { ... }` or `name() { ... }`
- **Local variables**: `local VAR=value`
- **Loops**: `for`, `while`, `until`
- **Symbolic links**: `ln -s target link`
- **Hard links**: `ln target link`

## Default Layout

When created without options, BashEnv provides a Unix-like directory structure:

- `/home/user` - Default working directory (and `$HOME`)
- `/bin` - Contains stubs for all built-in commands
- `/usr/bin` - Additional binary directory
- `/tmp` - Temporary files directory

Commands can be invoked by path (e.g., `/bin/ls`) or by name.

## Execution Protection

BashEnv includes protection against infinite loops and deep recursion:

- **Max call depth**: Limits function recursion (default: 100)
- **Max loop iterations**: Limits for/while/until loops (default: 10000)

These can be configured via constructor options. Error messages include hints on how to increase limits if needed.

## Development

```bash
pnpm test        # Run tests in watch mode
pnpm test:run    # Run tests once
pnpm typecheck   # Type check without emitting
pnpm build       # Build TypeScript
pnpm shell       # Run interactive shell
```

## License

ISC
