# Agent Scenario: Codebase Exploration and Modification

An AI agent exploring a TypeScript codebase to understand its structure, find specific implementations, and make targeted modifications.

## Initial Files

```
/project/src/BashEnv.ts
/project/src/fs.ts
/project/src/types.ts
/project/src/commands/ls/ls.ts
/project/src/commands/ls/ls.test.ts
/project/src/commands/grep/grep.ts
/project/src/commands/find/find.ts
/project/src/commands/cat/cat.ts
/project/src/comparison-tests/ls.comparison.test.ts
/project/src/comparison-tests/test-helpers.ts
/project/package.json
/project/tsconfig.json
```

## Scenario

The agent needs to:
1. Understand the project structure
2. Find where commands are registered
3. Locate specific functionality (e.g., how ls handles flags)
4. Find all test files for a specific command
5. Search for TODOs or skipped tests
6. Understand how the virtual filesystem works

## Commands to Run

```bash
# 1. Get overview of project structure
ls -la /project
ls -R /project/src | head -50

# 2. Find all TypeScript files
find /project/src -name "*.ts" | sort

# 3. Find all test files
find /project/src -name "*.test.ts" | sort

# 4. Search for where commands are registered
grep -r "registerCommand" /project/src

# 5. Find all command implementations
find /project/src/commands -name "*.ts" -type f | grep -v test

# 6. Search for skipped tests
grep -rn "it.skip\|describe.skip" /project/src

# 7. Find TODO comments
grep -rn "TODO\|FIXME" /project/src

# 8. Understand how a specific command works
cat /project/src/commands/ls/ls.ts | head -50

# 9. Find all usages of a specific function
grep -rn "resolvePath" /project/src

# 10. Check the interface definitions
cat /project/src/types.ts

# 11. Find comparison tests for a specific command
ls /project/src/comparison-tests/ | grep ls

# 12. Search for specific patterns in test files
grep -r "compareOutputs" /project/src/comparison-tests/

# 13. Find files that import a specific module
grep -rl "from.*BashEnv" /project/src

# 14. Check package dependencies
cat /project/package.json

# 15. Find all files modified recently (by content pattern)
grep -rl "showAll\|showAlmostAll" /project/src

# 16. Search for error handling patterns
grep -rn "catch\|throw" /project/src/commands/ls/ls.ts

# 17. Find all exports from a module
grep -n "^export" /project/src/fs.ts

# 18. Look for async functions
grep -rn "async.*execute" /project/src/commands

# 19. Check test patterns
cat /project/src/commands/ls/ls.test.ts | grep "it\|describe" | head -20

# 20. Find interface implementations
grep -rn "implements.*Command" /project/src
```

## Expected Behavior

Each command should help the agent build a mental model of:
- Project structure and organization
- Where specific functionality lives
- How components interact
- What tests exist and what's missing
- Code patterns used throughout
