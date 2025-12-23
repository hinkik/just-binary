# Agent instructions

- Install packages via pnpm rather than editing package.json directly
- Prefer asserting the full STDOUT/STDERR output rather than using to.contain or to.not.contain
- When you are unsure about bash/command behavior, create a `comparison-tests` test file to ensure compat.
