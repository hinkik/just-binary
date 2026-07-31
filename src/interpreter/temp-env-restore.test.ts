import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { toText } from "../test-utils.js";

// Temp assignments (`FOO=bar cmd`) must be restored even when the command
// exits its scope by throwing (break/continue) instead of returning.
// Restoration lives in a finally block; these tests match real bash.
describe("temp env restoration on control flow", () => {
  it("restores a temp assignment when the command is break", async () => {
    const bash = new Bash();
    const result = await toText(
      await bash.exec('for i in 1; do FOO=bar break; done; echo "[$FOO]"'),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]\n");
    expect(result.stderr).toBe("");
  });

  it("restores a temp assignment when the command is continue", async () => {
    const bash = new Bash();
    const result = await toText(
      await bash.exec('for i in 1 2; do FOO=bar continue; done; echo "[$FOO]"'),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[]\n");
    expect(result.stderr).toBe("");
  });

  it("restores a prior value, not just unsets", async () => {
    const bash = new Bash();
    const result = await toText(
      await bash.exec(
        'FOO=old; for i in 1; do FOO=new break; done; echo "[$FOO]"',
      ),
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[old]\n");
    expect(result.stderr).toBe("");
  });
});
