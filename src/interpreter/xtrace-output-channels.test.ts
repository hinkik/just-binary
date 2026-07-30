import { describe, expect, it } from "vitest";
import { Bash } from "../Bash.js";
import { InMemoryFs } from "../fs/in-memory-fs/index.js";
import { toText } from "../test-utils.js";

async function execute(script: string) {
  const result = await toText(await new Bash().exec(script));
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

describe("xtrace output channels", () => {
  it("traces every for-loop iteration exactly like bash", async () => {
    expect(await execute("set -x; for i in 1 2; do echo $i; done")).toEqual({
      stdout: "1\n2\n",
      stderr:
        "+ for i in 1 2\n" + "+ echo 1\n" + "+ for i in 1 2\n" + "+ echo 2\n",
      exitCode: 0,
    });
  });

  it("traces both pipeline stages in execution order", async () => {
    expect(await execute("set -x; echo alpha | cat")).toEqual({
      stdout: "alpha\n",
      stderr: "+ echo alpha\n+ cat\n",
      exitCode: 0,
    });
  });

  it("adds a nested trace prefix inside command substitution", async () => {
    expect(await execute('set -x; value=$(echo inner); echo "$value"')).toEqual(
      {
        stdout: "inner\n",
        stderr: "++ echo inner\n+ value=inner\n+ echo inner\n",
        exitCode: 0,
      },
    );
  });

  it("traces a prefix assignment before its command", async () => {
    expect(await execute("set -x; FOO=bar echo value")).toEqual({
      stdout: "value\n",
      stderr: "+ FOO=bar\n+ echo value\n",
      exitCode: 0,
    });
  });

  it("writes a command's xtrace before installing its local stderr redirect", async () => {
    const fs = new InMemoryFs();
    const result = await toText(
      await new Bash({ fs, cwd: "/" }).exec(
        "set -x; echo visible 2>trace-file",
      ),
    );

    expect({
      file: await fs.readFileText("/trace-file"),
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
    }).toEqual({
      file: "",
      stdout: "visible\n",
      stderr: "+ echo visible\n",
      exitCode: 0,
    });
  });
});
