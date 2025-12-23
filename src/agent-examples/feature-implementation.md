# Agent Scenario: Feature Implementation Workflow

An AI agent implementing new features in a bash-env project by exploring the codebase, understanding existing patterns, finding skipped tests, implementing fixes, and verifying with comparison tests.

This scenario is based on a real workflow: implementing `.` and `..` support for `ls -a`, fixing `ls -R` output format, and adding `true`/`false` commands.

## Initial Files

The agent works with a bash-env project that simulates bash commands in TypeScript:

```
/project/src/BashEnv.ts           - Main class that orchestrates commands
/project/src/fs.ts                - Virtual filesystem implementation
/project/src/commands/ls/ls.ts    - ls command implementation
/project/src/commands/ls/ls.test.ts
/project/src/commands/find/find.ts
/project/src/comparison-tests/ls.comparison.test.ts
/project/src/comparison-tests/test-helpers.ts
```

## Workflow Steps

### Step 1: Find skipped tests to understand what needs implementing
```bash
grep -rn "it.skip\|describe.skip" /project/src
```

### Step 2: Read the skipped test to understand requirements
```bash
cat /project/src/comparison-tests/ls.comparison.test.ts
```

### Step 3: Understand the current implementation
```bash
cat /project/src/commands/ls/ls.ts
grep -n "showAll\|showHidden" /project/src/commands/ls/ls.ts
```

### Step 4: Check how real bash behaves (comparison test helper)
```bash
cat /project/src/comparison-tests/test-helpers.ts
```

### Step 5: Find where commands are registered
```bash
grep -n "registerCommand" /project/src/BashEnv.ts
```

### Step 6: Look for similar implementations for reference
```bash
grep -rn "async execute" /project/src/commands
```

### Step 7: After making changes, verify unit tests
```bash
grep -n "should\|expect" /project/src/commands/ls/ls.test.ts
```

### Step 8: Check for related tests that might need updating
```bash
grep -rl "ls -a\|ls -A" /project/src
```

## Expected Agent Behavior

1. Discover what's broken/missing via skipped tests
2. Read implementations to understand patterns
3. Make targeted modifications
4. Update related tests
5. Verify changes work correctly
