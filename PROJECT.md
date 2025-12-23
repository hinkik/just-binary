# Overview

Build a class BashEnv that represents a fully simulated bash environment, but without the ability to run native code. All bash commands are implemented in TS and run on the virtual FS.

- All written in typescript
- Receive a set of files to store in a file system. The file system should be kept in memory but use an async abstraction for a file system
- exec method that runs a shell command
- read files and write files methods that allow access to the fs via the BashEnv instance
- Support for ls, mkdir, grep, cat, pipes, STDOUT, STDERR, etc with the most commonly used options
- Make it easy to add more commands
- Build a strong testing system with vitess where each test follows the pattern

  - Make env with files
  - Run command(s)
  - Assert output and state of FS is correct
  - No mocking since it is all virtual

- ALWAYS start by reading AGENTS.md

## Implementation

- First step write a file `bash-examples.md` of commands that should be supported.
- Commands should be in their own directory like `./commands/grep/grep.ts` and be neatly organized with unit tests if needed
- As much as possible reuse command-related npm packages to avoid implementing too much yourself
- Do `cat` and `echo` before complicated thinks like `sed` and `awk`

## Implementation phase 2

- Make a dedicated test file for bash syntax like logical or, etc.
- I really care about grep. Lets ensure it works incredibly well
- Imagine you are an AI agent that has a bash tool and a filesystem. Write a set of scenarios into ./agent-examples/$scenario.md of files that might exist and bash commands you'd want to run to explore these files.

## Implementation phase 3

- Separate FS and VirtualFS into an abstraction that allows the caller of BashEnv to supply their own FS
- Turn each agent-examples/\*.md file into a .test.ts file that validates the scenario works as expected
- Implement the more advanced commands from bash-examples.md

## Implementation phase 4

- Add a set of tests that compare our virtual BashEnv to a real bash
  - Each test should create a directory in /tmp/test-name
  - Put files
  - Ue node.js shell exec to actually run bash commands on those files
  - Collect output
  - Create equivalent BashEnv
  - Compare outputs to be identical

## Implementation phase 5

- Implement `cd` and a notion of a current working directory. Add unit tests.
- Implement a true virtual shell that I can boot and use as a human on my tty
